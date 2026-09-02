# Security policy

## Supported status

`dsh-rlm` is pre-1.0 experimental software. The M1 execution loop is working,
but the M2 reliability and security hardening milestone is not complete.

## Trusted-execution boundary

The local Python kernel is not a sandbox. Code submitted through `rlm_eval` runs
with the filesystem, process, and network authority of the DSH host user.

Do not enable this plugin for:

- untrusted users or tenants;
- untrusted prompt sources;
- workspaces containing secrets the Agent must not read.

The Python kernel child receives only a fixed safe-name allowlist instead of the
full host environment. Windows keeps `PATH`, `SystemRoot`, `WINDIR`, `COMSPEC`,
`PATHEXT`, `SYSTEMDRIVE`, `USERPROFILE`, `TEMP`, and `TMP` (matched
case-insensitively and emitted in canonical casing). POSIX keeps `PATH`,
`HOME`, `TMPDIR`, `TEMP`, `TMP`, `LANG`, and only the exact standard `LC_*`
category names (`LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `LC_COLLATE`,
`LC_MONETARY`, `LC_NUMERIC`, `LC_TIME`, `LC_PAPER`, `LC_NAME`, `LC_ADDRESS`,
`LC_TELEPHONE`, `LC_MEASUREMENT`, `LC_IDENTIFICATION`). Both platforms also
keep the public Python startup items `PYTHONIOENCODING`, `PYTHONUTF8`,
`PYTHONUNBUFFERED`, and `PYTHONPATH`. No arbitrary environment passthrough is
supported, and a custom `python` command uses the same filtered environment, so
it must be resolvable through the allowlisted `PATH` or as an absolute path;
commands that depend on extra ambient environment variables are not supported
in V1. Proxy variables, `VIRTUAL_ENV`/`CONDA_*`, `PYTHONHOME`,
`LD_LIBRARY_PATH`, `DSH_*`, and credential-looking variables (for example
`*API_KEY`, `*TOKEN`, `*SECRET`, `*CREDENTIAL`) are never forwarded.

This is credential hygiene, not a filesystem/process/network sandbox: trusted
code submitted through `rlm_eval` can still read files readable by the host
user, access the network, start processes, and read on-disk credential files.
The original environment-inheritance gap was tracked and fixed in
[Issue #7](https://github.com/leinasi2014/dsh-rlm/issues/7).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for the repository when it
is available. Do not include credentials, private Session logs, user data, or a
working exploit against another person's environment in a public Issue.

For ordinary non-sensitive reliability defects, open a GitHub Issue with a
minimal reproduction and the affected operating system.

## Disclosure expectations

We will acknowledge a private report, reproduce it against a pinned commit,
classify the affected trust boundary, and keep sensitive details private until a
fix or mitigation is available. No response-time SLA is currently offered.
