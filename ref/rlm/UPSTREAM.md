# RLM upstream

- Repository: <https://github.com/alexzhang13/rlm>
- Branch: `main`
- Frozen commit: `854e688fbba9d8f8989e3da9989812e4b6dfe270`
- Local evidence checkout: `source/`
- License: MIT; see `source/LICENSE`

Use this repository as architecture and implementation prior art for the RLM inference
model. Its Python classes, backend clients, sandbox choices, training environment, and
log format are not DSH contracts. The DSH implementation keeps official Session and
Agent lifecycle canonical and isolates optional Python execution behind a Provider.

