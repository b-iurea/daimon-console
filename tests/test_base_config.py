"""The box-rendered config keeps its promises: sovereign (no telemetry), pointed at the local brain, Daimon-skinned."""
from pathlib import Path

import yaml

CFG = yaml.safe_load((Path(__file__).resolve().parents[1] / "config" / "base.yaml").read_text())


def test_telemetry_silently_declined():
    sm = CFG["telemetry"]["shared_metrics"]
    assert sm == {"enabled": False, "send": False, "offer_version": 2}
    # offer_version must match upstream shared_metrics_consent.OFFER_VERSION or Hermes re-asks


def test_brain_endpoint_is_loopback_llama_server():
    m = CFG["model"]
    assert m["provider"] == "custom"
    assert m["base_url"] == "http://127.0.0.1:8080/v1"  # daimon's llm module `port` default


def test_daimon_skin_and_tui():
    assert CFG["display"]["skin"] == "daimon"
    assert CFG["display"]["interface"] == "tui"
