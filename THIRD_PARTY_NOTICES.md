# Third-party sources

Atlas's MIT license covers its own code. It does not replace the terms of referenced plugins,
host services, or patch targets. No third-party runtime or dependency tree is bundled here.

Local published-package metadata checked on 2026-11-15:

| Reference | Local source fact | Use in Atlas |
|---|---|---|
| `@linxin666/dsh-liangshen` 0.4.16 | `package.json` declares Apache-2.0; its LICENSE contains Apache License 2.0. Repository: [dsh-web](https://github.com/zhu1090093659/dsh-web). The supplied license is retained in `licenses/dsh-liangshen-Apache-2.0.txt`. | `patches/known-patches.json`: `liangshen-burst` references the upstream component mount expression and supplies a local replacement. |
| `@linxin666/dsh-agents` 0.4.16 | Published metadata declares Apache-2.0 and the same dsh-web repository; the local installed package has no standalone LICENSE/NOTICE file. | Host LLM API usage was consulted; Atlas implements its own service lookup and routing. |
| `surfcore` 0.8.9 | Local package metadata declares MIT; the inspected package has no repository field or standalone LICENSE/NOTICE file. | `surfcore-whitelist`, `surfcore-health`, `surfcore-setup`, `surfcore-snowluma-lock` identify existing target files and local modifications; the surfcore runtime is not bundled. |
| `@snowluma/runtime` 2.4.2 | Local metadata says `SEE LICENSE IN LICENSE`; this is not an MIT declaration. This check does not establish the target runtime's redistribution terms. | `snowluma-windowshide` identifies an existing installation's spawn options; the runtime is not redistributed. |

Patch definitions describe local modifications, not upstream endorsements. Preserve these source
references when distributing the definitions. A metadata declaration is not a complete rights audit;
unverified upstream notice/redistribution details remain for the project owner to review before a release.
