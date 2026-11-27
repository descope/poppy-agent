# Changelog

## [2.0.0](https://github.com/descope/poppy-agent/compare/poppy-agent-v1.0.0...poppy-agent-v2.0.0) (2026-11-27)


### ⚠ BREAKING CHANGES

* `Approval` now requires `approver`, so build approvals with `userApproval()` / `agentApproval()` rather than by hand, and `approvalFor(operation)` now takes a second argument saying who approved. `Operation.summary` is `string | undefined`, since section 3 makes it optional, and `Operation` gained `expiresAtMs`. `poppyTools`' `requestApproval` may return an approver rather than only a boolean, and its results say `approved_by: "user" | "agent"` in place of `approved_by_user`. `parseEvent()` takes an optional `Company`.

### Features

* version 3 of the Operations extension ([#37](https://github.com/descope/poppy-agent/issues/37)) ([ed25c10](https://github.com/descope/poppy-agent/commit/ed25c10a447d8763ebbbaba1c3a08eba1cf0fa35))


### Bug Fixes

* hold pnpm at 11, which corepack can actually launch ([#30](https://github.com/descope/poppy-agent/issues/30)) ([ae9c250](https://github.com/descope/poppy-agent/commit/ae9c25014af8d10992daa59b6ba215f803d49d2a))
* point the package and its instructions at poppy-agent ([#42](https://github.com/descope/poppy-agent/issues/42)) ([0044fdb](https://github.com/descope/poppy-agent/commit/0044fdb719f27b10e27e4dfd13d82bd75f9afbab))
* **tools:** keep a message whose role a later version added ([#41](https://github.com/descope/poppy-agent/issues/41)) ([97ee674](https://github.com/descope/poppy-agent/commit/97ee6746616bfec9f9b03451e8568337eb9c7288))
* **tools:** name a Company by the domain that was verified ([#34](https://github.com/descope/poppy-agent/issues/34)) ([2e77761](https://github.com/descope/poppy-agent/commit/2e777615a5d7fa5a4b9cd05a8028417d5e20efa7))

## 1.0.0 (2026-11-17)


### ⚠ BREAKING CHANGES

* the ./conformance export is gone. Import the suite from @descope/poppy-conformance instead.
* support Personal Agent Protocol 0.4 as well as 0.3 ([#15](https://github.com/descope/poppy-js/issues/15))
* implement Personal Agent Protocol draft 0.3 ([#8](https://github.com/descope/poppy-js/issues/8))

### Features

* check the six requirements the suite was silent on ([#22](https://github.com/descope/poppy-js/issues/22)) ([b87428d](https://github.com/descope/poppy-js/commit/b87428df973695304125234f6b97bb19937beb5b))
* **conformance:** check a Company's discovery chain, not just an agent's ([#24](https://github.com/descope/poppy-js/issues/24)) ([e83e379](https://github.com/descope/poppy-js/commit/e83e379d45035748a8b344436da0b371c818d287))
* implement Personal Agent Protocol draft 0.3 ([#8](https://github.com/descope/poppy-js/issues/8)) ([2ef9f83](https://github.com/descope/poppy-js/commit/2ef9f8300ea0d328af88fad375a339e764c93bf7))
* move the conformance suite to descope/poppy-conformance ([#29](https://github.com/descope/poppy-js/issues/29)) ([4944479](https://github.com/descope/poppy-js/commit/49444790152e9e86127236f36f9a529249f9917a))
* support Personal Agent Protocol 0.4 as well as 0.3 ([#15](https://github.com/descope/poppy-js/issues/15)) ([bdf597a](https://github.com/descope/poppy-js/commit/bdf597a7a1fa48a911f493a226bbf026e8392b48))
* support Personal Agent Protocol 1.0 as well as 0.4 and 0.3 ([#25](https://github.com/descope/poppy-js/issues/25)) ([7d8c479](https://github.com/descope/poppy-js/commit/7d8c4794d61318b89f232854fa1448b3ebf47823))
* v0.1 agent-side SDK ([#2](https://github.com/descope/poppy-js/issues/2)) ([6cda861](https://github.com/descope/poppy-js/commit/6cda861677976bd35550779f76bdd3bf3d2f52e0))

## Changelog
