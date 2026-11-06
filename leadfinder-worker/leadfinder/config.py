"""YAML config loaders for config/*.yaml."""
from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml

from leadfinder.settings import CONFIG_DIR


def load_yaml(name: str, config_dir: Path | None = None) -> dict[str, Any]:
    path = (config_dir or CONFIG_DIR) / name
    with path.open(encoding="utf-8") as fh:
        return yaml.safe_load(fh) or {}


def offices_config(config_dir: Path | None = None) -> dict[str, Any]:
    return load_yaml("offices.yaml", config_dir)


def sources_config(config_dir: Path | None = None) -> dict[str, Any]:
    return load_yaml("sources.yaml", config_dir)


def scoring_config(config_dir: Path | None = None) -> dict[str, Any]:
    return load_yaml("scoring.yaml", config_dir)


def save_sources_config(data: dict[str, Any], config_dir: Path | None = None) -> None:
    path = (config_dir or CONFIG_DIR) / "sources.yaml"
    with path.open("w", encoding="utf-8") as fh:
        yaml.safe_dump(data, fh, sort_keys=False, allow_unicode=True)
