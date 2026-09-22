import base64
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse


CODEX_BASE_URL = os.getenv("CODEX_BASE_URL", "https://chatgpt.com/backend-api/codex").rstrip("/")
CODEX_OAUTH_CLIENT_ID = os.getenv("CODEX_OAUTH_CLIENT_ID", "app_EMoamEEZ73f0CkXaXp7hrann")
CODEX_ISSUER = "https://auth.openai.com"
CODEX_OAUTH_TOKEN_URL = f"{CODEX_ISSUER}/oauth/token"
CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120
CODEX_DEFAULT_MODEL = os.getenv("CODEX_MODEL", os.getenv("CUSTOM_OPENAI_MODEL", "gpt-5.4"))
CODEX_AUTH_PATH = Path(os.getenv("CODEX_AUTH_FILE", os.path.expanduser("~/.codex/auth.json"))).expanduser()
CODEX_REQUEST_TIMEOUT = float(os.getenv("CODEX_REQUEST_TIMEOUT", "120"))

router = APIRouter()


def _decode_jwt_claims(token: str) -> Dict[str, Any]:
    if not isinstance(token, str) or token.count(".") != 2:
        return {}
    payload = token.split(".")[1]
    payload += "=" * ((4 - len(payload) % 4) % 4)
    try:
        return json.loads(base64.urlsafe_b64decode(payload.encode()).decode())
    except Exception:
        return {}


def _read_auth() -> Dict[str, Any]:
    if not CODEX_AUTH_PATH.is_file():
        raise HTTPException(401, detail="Codex auth is missing. Login from the Codex Auth panel first.")
    try:
        payload = json.loads(CODEX_AUTH_PATH.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(500, detail=f"Failed to read Codex auth file: {exc}") from exc
    tokens = payload.get("tokens")
    if not isinstance(tokens, dict):
        raise HTTPException(401, detail="Codex auth file has no tokens object.")
    return payload


def _write_auth(tokens: Dict[str, Any]) -> None:
    CODEX_AUTH_PATH.parent.mkdir(parents=True, exist_ok=True)
    payload: Dict[str, Any] = {}
    if CODEX_AUTH_PATH.is_file():
        try:
            payload = json.loads(CODEX_AUTH_PATH.read_text(encoding="utf-8"))
        except Exception:
            payload = {}
    payload["auth_mode"] = "chatgpt"
    payload["last_refresh"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    payload["tokens"] = tokens
    tmp_path = CODEX_AUTH_PATH.with_suffix(".json.tmp")
    tmp_path.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp_path, CODEX_AUTH_PATH)


def _token_status(payload: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    try:
        payload = payload or _read_auth()
    except HTTPException:
        return {"authenticated": False, "auth_path": str(CODEX_AUTH_PATH)}
    tokens = payload.get("tokens") or {}
    claims = _decode_jwt_claims(str(tokens.get("access_token") or ""))
    exp = claims.get("exp")
    return {
        "authenticated": bool(tokens.get("access_token") and tokens.get("refresh_token")),
        "auth_path": str(CODEX_AUTH_PATH),
        "account_id": tokens.get("account_id") or claims.get("https://api.openai.com/auth", {}).get("chatgpt_account_id"),
        "expires_at": exp,
        "expires_in": int(exp - time.time()) if isinstance(exp, (int, float)) else None,
        "last_refresh": payload.get("last_refresh"),
    }


def _access_token_is_expiring(access_token: str) -> bool:
    exp = _decode_jwt_claims(access_token).get("exp")
    if not isinstance(exp, (int, float)):
        return False
    return float(exp) <= time.time() + CODEX_ACCESS_TOKEN_REFRESH_SKEW_SECONDS


async def _refresh_tokens(tokens: Dict[str, Any]) -> Dict[str, Any]:
    refresh_token = str(tokens.get("refresh_token") or "").strip()
    if not refresh_token:
        raise HTTPException(401, detail="Codex refresh_token is missing. Login again.")
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.post(
            CODEX_OAUTH_TOKEN_URL,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            data={
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
                "client_id": CODEX_OAUTH_CLIENT_ID,
            },
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, detail=f"Codex token refresh failed: {resp.text[:500]}")
    data = resp.json()
    updated = dict(tokens)
    updated["access_token"] = data.get("access_token") or updated.get("access_token")
    updated["refresh_token"] = data.get("refresh_token") or updated.get("refresh_token")
    if data.get("id_token"):
        updated["id_token"] = data["id_token"]
    _write_auth(updated)
    return updated


async def _get_access_token() -> str:
    payload = _read_auth()
    tokens = dict(payload.get("tokens") or {})
    access_token = str(tokens.get("access_token") or "").strip()
    if not access_token:
        raise HTTPException(401, detail="Codex access_token is missing. Login again.")
    if _access_token_is_expiring(access_token):
        tokens = await _refresh_tokens(tokens)
        access_token = str(tokens.get("access_token") or "").strip()
    return access_token


def _normalize_content(content: Any) -> Any:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: List[Dict[str, Any]] = []
        for item in content:
            if isinstance(item, str):
                parts.append({"type": "input_text", "text": item})
            elif isinstance(item, dict):
                item_type = item.get("type")
                if item_type in {"text", "input_text"}:
                    parts.append({"type": "input_text", "text": str(item.get("text") or "")})
                elif item_type == "image_url":
                    image_url = item.get("image_url")
                    url = image_url.get("url") if isinstance(image_url, dict) else image_url
                    if url:
                        parts.append({"type": "input_image", "image_url": url})
        return parts or ""
    return str(content or "")


def _chat_to_responses_payload(body: Dict[str, Any]) -> Dict[str, Any]:
    instructions = "You are a helpful assistant."
    input_messages: List[Dict[str, Any]] = []
    for msg in body.get("messages") or []:
        if not isinstance(msg, dict):
            continue
        role = str(msg.get("role") or "user").lower()
        content = _normalize_content(msg.get("content", ""))
        if role == "system":
            instructions = str(content)
        elif role in {"user", "assistant"}:
            input_messages.append({"role": role, "content": content})

    return {
        "model": body.get("model") or CODEX_DEFAULT_MODEL,
        "instructions": instructions,
        "input": input_messages or [{"role": "user", "content": ""}],
        "store": False,
        "stream": bool(body.get("stream")),
        "max_output_tokens": body.get("max_tokens") or body.get("max_completion_tokens"),
    }


def _drop_none(data: Dict[str, Any]) -> Dict[str, Any]:
    return {k: v for k, v in data.items() if v is not None}


def _extract_text(data: Dict[str, Any]) -> str:
    if isinstance(data.get("output_text"), str) and data["output_text"].strip():
        return data["output_text"].strip()
    chunks: List[str] = []
    for item in data.get("output") or []:
        if not isinstance(item, dict) or item.get("type") != "message":
            continue
        for part in item.get("content") or []:
            if isinstance(part, dict) and part.get("type") in {"output_text", "text"}:
                text = part.get("text")
                if isinstance(text, str):
                    chunks.append(text)
    return "".join(chunks).strip()


def _chat_response(body: Dict[str, Any], data: Dict[str, Any]) -> Dict[str, Any]:
    model = body.get("model") or data.get("model") or CODEX_DEFAULT_MODEL
    content = _extract_text(data)
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    return {
        "id": data.get("id") or f"chatcmpl-{int(time.time())}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [{
            "index": 0,
            "message": {"role": "assistant", "content": content},
            "finish_reason": "stop",
        }],
        "usage": {
            "prompt_tokens": usage.get("input_tokens", 0),
            "completion_tokens": usage.get("output_tokens", 0),
            "total_tokens": usage.get("total_tokens", 0),
        },
    }


@router.get("/codex-auth/status")
async def codex_auth_status() -> Dict[str, Any]:
    return _token_status()


@router.post("/codex-auth/start")
async def codex_auth_start() -> Dict[str, Any]:
    async with httpx.AsyncClient(timeout=20.0) as client:
        resp = await client.post(
            f"{CODEX_ISSUER}/api/accounts/deviceauth/usercode",
            json={"client_id": CODEX_OAUTH_CLIENT_ID},
            headers={"Content-Type": "application/json"},
        )
    if resp.status_code != 200:
        raise HTTPException(resp.status_code, detail=f"Device code request failed: {resp.text[:500]}")
    data = resp.json()
    return {
        "device_auth_id": data.get("device_auth_id"),
        "user_code": data.get("user_code"),
        "verification_uri": f"{CODEX_ISSUER}/codex/device",
        "interval": max(3, int(data.get("interval") or 5)),
        "expires_in": data.get("expires_in"),
    }


@router.post("/codex-auth/poll")
async def codex_auth_poll(body: Dict[str, Any]) -> Dict[str, Any]:
    device_auth_id = str(body.get("device_auth_id") or "").strip()
    user_code = str(body.get("user_code") or "").strip()
    if not device_auth_id or not user_code:
        raise HTTPException(400, detail="device_auth_id and user_code are required.")

    async with httpx.AsyncClient(timeout=20.0) as client:
        poll_resp = await client.post(
            f"{CODEX_ISSUER}/api/accounts/deviceauth/token",
            json={"device_auth_id": device_auth_id, "user_code": user_code},
            headers={"Content-Type": "application/json"},
        )
    if poll_resp.status_code in (403, 404):
        return {"authenticated": False, "pending": True}
    if poll_resp.status_code != 200:
        raise HTTPException(poll_resp.status_code, detail=f"Device auth polling failed: {poll_resp.text[:500]}")

    code_resp = poll_resp.json()
    authorization_code = code_resp.get("authorization_code")
    code_verifier = code_resp.get("code_verifier")
    if not authorization_code or not code_verifier:
        raise HTTPException(500, detail="Device auth response missing authorization_code or code_verifier.")

    async with httpx.AsyncClient(timeout=20.0) as client:
        token_resp = await client.post(
            CODEX_OAUTH_TOKEN_URL,
            data={
                "grant_type": "authorization_code",
                "code": authorization_code,
                "redirect_uri": f"{CODEX_ISSUER}/deviceauth/callback",
                "client_id": CODEX_OAUTH_CLIENT_ID,
                "code_verifier": code_verifier,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if token_resp.status_code != 200:
        raise HTTPException(token_resp.status_code, detail=f"Token exchange failed: {token_resp.text[:500]}")
    tokens = token_resp.json()
    if not tokens.get("access_token"):
        raise HTTPException(500, detail="Token exchange returned no access_token.")
    _write_auth(tokens)
    return {"authenticated": True, "pending": False, **_token_status({"tokens": tokens})}


@router.post("/codex-auth/refresh")
async def codex_auth_refresh() -> Dict[str, Any]:
    payload = _read_auth()
    tokens = await _refresh_tokens(dict(payload.get("tokens") or {}))
    return {"refreshed": True, **_token_status({"tokens": tokens})}


@router.delete("/codex-auth/logout")
async def codex_auth_logout() -> Dict[str, Any]:
    if CODEX_AUTH_PATH.exists():
        CODEX_AUTH_PATH.unlink()
    return {"authenticated": False, "auth_path": str(CODEX_AUTH_PATH)}


@router.get("/v1/models")
async def codex_models() -> Dict[str, Any]:
    token = await _get_access_token()
    async with httpx.AsyncClient(timeout=30.0) as client:
        resp = await client.get(
            f"{CODEX_BASE_URL}/models?client_version=1.0.0",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/json"},
        )
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, detail=resp.text[:1000])
    try:
        data = resp.json()
    except Exception:
        data = []
    items = data if isinstance(data, list) else data.get("data", []) if isinstance(data, dict) else []
    return {
        "object": "list",
        "data": [
            {"id": item if isinstance(item, str) else item.get("id") or item.get("name"), "object": "model", "owned_by": "codex"}
            for item in items
            if (isinstance(item, str) or isinstance(item, dict))
        ],
    }


@router.post("/v1/chat/completions")
async def codex_chat_completions(request: Request):
    body = await request.json()
    token = await _get_access_token()
    payload = _drop_none(_chat_to_responses_payload(body))

    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream" if payload.get("stream") else "application/json",
    }

    if payload.get("stream"):
        async def stream():
            async with httpx.AsyncClient(timeout=CODEX_REQUEST_TIMEOUT) as client:
                async with client.stream("POST", f"{CODEX_BASE_URL}/responses", headers=headers, json=payload) as resp:
                    if resp.status_code >= 400:
                        detail = await resp.aread()
                        yield f"data: {json.dumps({'error': detail.decode(errors='replace')[:1000]})}\n\n"
                        return
                    async for line in resp.aiter_lines():
                        if not line.startswith("data: "):
                            continue
                        raw = line[6:].strip()
                        if not raw or raw == "[DONE]":
                            continue
                        try:
                            event = json.loads(raw)
                        except Exception:
                            continue
                        if event.get("type") == "response.output_text.delta":
                            chunk = {
                                "id": f"chatcmpl-{int(time.time())}",
                                "object": "chat.completion.chunk",
                                "created": int(time.time()),
                                "model": body.get("model") or CODEX_DEFAULT_MODEL,
                                "choices": [{"index": 0, "delta": {"content": event.get("delta", "")}, "finish_reason": None}],
                            }
                            yield f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n"
                    yield "data: [DONE]\n\n"
        return StreamingResponse(stream(), media_type="text/event-stream")

    async with httpx.AsyncClient(timeout=CODEX_REQUEST_TIMEOUT) as client:
        resp = await client.post(f"{CODEX_BASE_URL}/responses", headers=headers, json=payload)
    if resp.status_code >= 400:
        raise HTTPException(resp.status_code, detail=resp.text[:1000])
    return _chat_response(body, resp.json())
