import pytest

from manga_translator.translators.sakura import SakuraTranslator


@pytest.mark.asyncio
async def test_sakura_normalizes_list_content_response():
    translator = SakuraTranslator()

    async def fake_request(_prompt):
        return [{"type": "text", "text": "你好"}]

    translator._request_translation = fake_request

    assert await translator._translate("JPN", "CHS", ["こんにちは"]) == ["你好"]
