from .base import SourceAdapter
from .kudago import KudaGoAdapter
from .timepad import TimepadAdapter

ADAPTERS: dict[str, type[SourceAdapter]] = {
    adapter.name: adapter for adapter in (KudaGoAdapter, TimepadAdapter)
}

__all__ = ["ADAPTERS", "SourceAdapter"]
