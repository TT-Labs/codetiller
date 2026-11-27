# Security

codetiller runs code written by an agent, so its trust boundary is the product. What the boundary
is and how it is measured: [trust boundary](docs/trust-boundary.md).

## Reporting a vulnerability

Report privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Do not
open a public issue.

Include the version (commit), how the factory is deployed (Docker or Kubernetes), and the steps to
reproduce. The output of `tiller audit` helps.

## What counts

- An agent or dependency-install container reaching anything but the gateway or the registry proxy.
- An agent reading a credential: the model API key, the forge token, the UI token.
- An agent changing how its own work is checked, or the sandbox it runs in.
- Spend above a run's budget.
- Access to the API or the dashboard without the token.

Not in scope: the factory's container holding the docker socket (documented; the factory is trusted
and belongs on a machine of its own), and anything that needs access to the factory's host.

Fixes land on `main`; there are no maintained release branches yet.
