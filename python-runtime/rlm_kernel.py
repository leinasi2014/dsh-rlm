#!/usr/bin/env python3
"""Minimal dsh-rlm Python kernel entry point.

M1 will turn this file into the persistent globals executor described in
docs/architecture.md. Until then it exits loudly if started directly.
"""

from __future__ import annotations

import sys


def main() -> int:
    sys.stderr.write("dsh-rlm: Python kernel is not implemented yet\n")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
