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
- workspaces containing secrets the Agent must not read;
- a DSH host started with sensitive ambient environment variables.

The current public audit confirmed that the Python child inherits the host
environment because `spawn()` does not yet supply an allowlisted environment.
That is tracked as a security issue and should be fixed before broader use.

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
