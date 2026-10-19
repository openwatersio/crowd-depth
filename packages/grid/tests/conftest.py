import pytest

from grid import reference


@pytest.fixture(autouse=True)
def own_cache(tmp_path, monkeypatch):
    """Each test gets its own download cache, never the machine's."""
    monkeypatch.setenv("GRID_CACHE_DIR", str(tmp_path / "cache"))
    monkeypatch.setattr(reference, "uncached", set())
