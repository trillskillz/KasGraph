# Pre-Public-Launch Checklist

KasGraph can be described as feature-complete core infrastructure, but do not
claim production-readiness until live testnet indexing and benchmark numbers
exist.

- [x] Fix KasBonds stable identity: Bond/Coupon/Redemption writes use
  covenant-based identity rather than block hash identity.
- [x] Add deploy endpoint auth: hosted `POST /subgraphs` and
  `DELETE /subgraphs/:id` require `Authorization: Bearer <token>` when
  `KASGRAPH_DEPLOY_TOKEN` is configured.
- [ ] Run real testnet indexing soak.
- [ ] Publish benchmark numbers.
- [ ] Confirm MCP 5/8 live and mark 3 remaining as planned.
- [ ] Confirm `kasgraph.com` hosted deployment status.
- [ ] Verify CI passes.
- [ ] Verify README claims match code.
- [ ] Keep production-readiness claims blocked until live testnet indexing and
  benchmarks exist.
