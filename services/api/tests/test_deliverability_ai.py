from app.services.deliverability import analyze_deliverability


def test_spammy_draft_scores_worse_than_clean():
    bad = analyze_deliverability(
        subject="FREE MONEY!!! CLICK HERE",
        body="Buy now limited time offer act now $$$ click here http://bit.ly/x http://bit.ly/y http://bit.ly/z http://bit.ly/w",
    )
    good = analyze_deliverability(
        subject="Quick question about Acme hiring",
        body="Hi Sam,\n\nI noticed Acme is hiring PMs. Would a short note about screening help?\n\nThanks,\nAlex",
    )
    assert bad["spam_risk"] in {"Medium", "High"}
    assert good["spam_risk"] == "Low"
    assert bad["score"] < good["score"]
    assert "dimensions" in good
    assert good["disclaimer"]


def test_fake_reply_subject_flagged():
    result = analyze_deliverability(subject="Re: your invoice", body="Hello, following up on pricing.")
    codes = {item["code"] for item in result["findings"]}
    assert "fake_thread" in codes


def test_findings_include_evidence():
    result = analyze_deliverability(subject="Hello", body="Dear friend, click here to buy now")
    assert result["findings"]
    assert any(item.get("evidence") for item in result["findings"])
