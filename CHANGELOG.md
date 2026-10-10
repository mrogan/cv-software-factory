# Changelog

## [0.6.0](https://github.com/mrogan/cv-software-factory/compare/v0.5.0...v0.6.0) (2026-10-10)


### Features

* **admission:** enforce the factory's image policy ([#185](https://github.com/mrogan/cv-software-factory/issues/185)) ([d9441e8](https://github.com/mrogan/cv-software-factory/commit/d9441e8d1e88ca8e581bb46551c0246ad765f5e2))
* **admission:** enforce the website's image policy ([#186](https://github.com/mrogan/cv-software-factory/issues/186)) ([bd11ef3](https://github.com/mrogan/cv-software-factory/commit/bd11ef3b8b98df8ef7ee83aa62576f172d24dc10))
* **deploy:** admit only images their pipeline signed, with Kyverno ([#174](https://github.com/mrogan/cv-software-factory/issues/174)) ([97aa373](https://github.com/mrogan/cv-software-factory/commit/97aa3730ad3110f97653c38fb68b8e4f4b99c1ab))
* **deploy:** install Argo Rollouts, and label the app's telemetry by version ([#170](https://github.com/mrogan/cv-software-factory/issues/170)) ([fb81c57](https://github.com/mrogan/cv-software-factory/commit/fb81c57ae0bf11e6910052b1a3950ff329588747))
* **deploy:** run the traffic generator in the cluster ([#172](https://github.com/mrogan/cv-software-factory/issues/172)) ([41bffca](https://github.com/mrogan/cv-software-factory/commit/41bffcade590e825db188fd9614cc8120fdf8fa5))
* **github:** sign every image, and propose only what the pipeline signed ([#169](https://github.com/mrogan/cv-software-factory/issues/169)) ([7ba69d6](https://github.com/mrogan/cv-software-factory/commit/7ba69d6929222714bd83a11738086587c7ed1038))
* **line:** abort a canary when the line stops, and fence the release ([#175](https://github.com/mrogan/cv-software-factory/issues/175)) ([f150844](https://github.com/mrogan/cv-software-factory/commit/f150844348c54c1b37a788df9b183f9a83b28068))
* **release:** judge the app's canary against its baseline, with traffic to judge by ([#171](https://github.com/mrogan/cv-software-factory/issues/171)) ([5a0d6fc](https://github.com/mrogan/cv-software-factory/commit/5a0d6fcfddb0f2cd9d0b310f736fbc85a5b0c185))


### Bug Fixes

* **admission:** verify the signature only, not the SBOM ([#184](https://github.com/mrogan/cv-software-factory/issues/184)) ([8adc43d](https://github.com/mrogan/cv-software-factory/commit/8adc43d77cc7b2bfb22c98722a4058cb5ae7de57))
* **deploy:** give the GitHub worker a writable /tmp, which TUF needs ([#187](https://github.com/mrogan/cv-software-factory/issues/187)) ([2e2877f](https://github.com/mrogan/cv-software-factory/commit/2e2877fa029a07f9ff45b1ddceb521f58eaca3f7))
* **github:** find a signature when GHCR's index carries no annotations ([#181](https://github.com/mrogan/cv-software-factory/issues/181)) ([1e44502](https://github.com/mrogan/cv-software-factory/commit/1e44502d1e7ac099a9baa0e41232bc66aa346f1b))

## [0.5.0](https://github.com/mrogan/cv-software-factory/compare/v0.4.0...v0.5.0) (2026-10-10)


### Features

* **console:** show a station at work while it holds an item for Martin ([#164](https://github.com/mrogan/cv-software-factory/issues/164)) ([b570e51](https://github.com/mrogan/cv-software-factory/commit/b570e51deb2eac286f8e490eb0806899306babd9))
* **console:** the line's work items, from spec to Martin's merge ([#102](https://github.com/mrogan/cv-software-factory/issues/102)) ([30a0f97](https://github.com/mrogan/cv-software-factory/commit/30a0f9791efdc7559b44c5bc9dddbb0f3ab2ee7e))
* **deploy:** run the GitHub worker on the local cluster ([#65](https://github.com/mrogan/cv-software-factory/issues/65)) ([110448f](https://github.com/mrogan/cv-software-factory/commit/110448f669cbed7a74cc911fc23da9cc169b9d30))
* **deploy:** run the line, and fence its runners ([#72](https://github.com/mrogan/cv-software-factory/issues/72)) ([9f113de](https://github.com/mrogan/cv-software-factory/commit/9f113dee9243c251f3f3bb300982fd43570993fb))
* **factory:** a GitHub worker that acts as the factory's App ([#62](https://github.com/mrogan/cv-software-factory/issues/62)) ([2d32591](https://github.com/mrogan/cv-software-factory/commit/2d32591d131c0fdf9a8e626e67eb075055bc9bc7))
* **factory:** the App opens the deploy and release pull requests ([#66](https://github.com/mrogan/cv-software-factory/issues/66)) ([bcb06d9](https://github.com/mrogan/cv-software-factory/commit/bcb06d98db1b023819af0bdf137900ece502d639))
* **gateway:** speak Anthropic's Messages API for runners ([#70](https://github.com/mrogan/cv-software-factory/issues/70)) ([1ec4a6e](https://github.com/mrogan/cv-software-factory/commit/1ec4a6e4525500d3b39f33bb8cb49a31731d87c4))
* **line:** hold every fix to its ticket, and send what else the planner notices to triage ([#158](https://github.com/mrogan/cv-software-factory/issues/158)) ([aced509](https://github.com/mrogan/cv-software-factory/commit/aced50930cc3cc9c0c3acfc5f5f217f9b18e3008))
* **line:** let the coder change nothing and say why, and hold for Martin ([#111](https://github.com/mrogan/cv-software-factory/issues/111)) ([098cd8a](https://github.com/mrogan/cv-software-factory/commit/098cd8a3aff2a036dfd029a0332289e5b95c1540))
* **line:** take at most LINE_TAKE work items, by the line's own rule ([#106](https://github.com/mrogan/cv-software-factory/issues/106)) ([8a3591f](https://github.com/mrogan/cv-software-factory/commit/8a3591f016b4b1e813e8cc28e31dd92a1ef7e01d))
* **line:** the bench, and cassettes that replay a step run again ([#97](https://github.com/mrogan/cv-software-factory/issues/97)) ([ff851a1](https://github.com/mrogan/cv-software-factory/commit/ff851a1a18698ac163b1da3966ab5381dcc8432e))
* **line:** the coder ([#99](https://github.com/mrogan/cv-software-factory/issues/99)) ([d34dd92](https://github.com/mrogan/cv-software-factory/commit/d34dd9298f4f090a8e0ca7fafbe931cf489bc507))
* **line:** the describer ([#101](https://github.com/mrogan/cv-software-factory/issues/101)) ([971f1e2](https://github.com/mrogan/cv-software-factory/commit/971f1e2ec143e51108af8f870de5b29dda121db1))
* **line:** the line after triage, from ticket to Martin's merge ([#96](https://github.com/mrogan/cv-software-factory/issues/96)) ([cd447bb](https://github.com/mrogan/cv-software-factory/commit/cd447bb6b8527f8261a7d173228b84341ddb0cd4))
* **line:** the planner ([#98](https://github.com/mrogan/cv-software-factory/issues/98)) ([7ad8dc4](https://github.com/mrogan/cv-software-factory/commit/7ad8dc4e641a1eb6adaeba637c3dcb23f20b5e23))
* **line:** the reviewer, and the loop back to the coder ([#100](https://github.com/mrogan/cv-software-factory/issues/100)) ([5779393](https://github.com/mrogan/cv-software-factory/commit/5779393cd81647c43408f2dd710c02b0026aacc0))
* **line:** what the overnight soak needs ([#103](https://github.com/mrogan/cv-software-factory/issues/103)) ([4917fd8](https://github.com/mrogan/cv-software-factory/commit/4917fd8731488d9ac4d1f02a7d050ce7d59e2b4a))
* require code-owner review on main, with a bypass for the admin ([#68](https://github.com/mrogan/cv-software-factory/issues/68)) ([288308e](https://github.com/mrogan/cv-software-factory/commit/288308eca609eeaeffc896fe0893577de0ea9141))
* runners, and the patch they hand back ([#71](https://github.com/mrogan/cv-software-factory/issues/71)) ([4ad6906](https://github.com/mrogan/cv-software-factory/commit/4ad690652cbf2b1da95cad3ff81844c26722fb7b))
* the app's gates, as a shared workflow ([#69](https://github.com/mrogan/cv-software-factory/issues/69)) ([bd57672](https://github.com/mrogan/cv-software-factory/commit/bd576722eb6d6fec91f82d5e8f8a56b8af4ab67b))


### Bug Fixes

* **console:** write a commit by its first seven characters, linked on the sheet ([#149](https://github.com/mrogan/cv-software-factory/issues/149)) ([32d1d32](https://github.com/mrogan/cv-software-factory/commit/32d1d32f9637de8c7bfc6c16383755622945521a))
* **crawler:** judge a page where it landed, and a route with no page as trouble ([#110](https://github.com/mrogan/cv-software-factory/issues/110)) ([9a2606a](https://github.com/mrogan/cv-software-factory/commit/9a2606a6a9b60e7bdcab7094560b95899e7b2de1))
* **deploy:** a default memory limit in runners, which the quota needs ([#89](https://github.com/mrogan/cv-software-factory/issues/89)) ([7f28cf0](https://github.com/mrogan/cv-software-factory/commit/7f28cf043bbeae09925f9b2788e364b518fd7742))
* **deploy:** the line's readiness on its handback port ([#88](https://github.com/mrogan/cv-software-factory/issues/88)) ([c74a0e2](https://github.com/mrogan/cv-software-factory/commit/c74a0e2095e03828409fb41a8541d096ef90d764))
* **gateway:** resume only the day and month caps after a restart ([#146](https://github.com/mrogan/cv-software-factory/issues/146)) ([9031b85](https://github.com/mrogan/cv-software-factory/commit/9031b8549ef0390003cce9cdeba896dd9d28bf07))
* **github:** describe a deploy pull request so it can be read ([#136](https://github.com/mrogan/cv-software-factory/issues/136)) ([0fa9f93](https://github.com/mrogan/cv-software-factory/commit/0fa9f933b1b5c788bbec8454bed8967ac961e642))
* **github:** keep a deploy branch to one writer, the deploy watch ([#148](https://github.com/mrogan/cv-software-factory/issues/148)) ([ce3de17](https://github.com/mrogan/cv-software-factory/commit/ce3de174ec0fddb6fb2c002138b24898805ae274))
* **github:** move a deploy pull request to a newer build without closing it ([#115](https://github.com/mrogan/cv-software-factory/issues/115)) ([0848e66](https://github.com/mrogan/cv-software-factory/commit/0848e6628ab4d41e14efed017918fc99a0ef9e08))
* **github:** refuse a patch path with a control character in it ([#127](https://github.com/mrogan/cv-software-factory/issues/127)) ([7c0597c](https://github.com/mrogan/cv-software-factory/commit/7c0597c92f900959882ce16393cee0388a095f12))
* **line:** count no call the provider refused in a step's model.called ([#147](https://github.com/mrogan/cv-software-factory/issues/147)) ([23e16b3](https://github.com/mrogan/cv-software-factory/commit/23e16b31d28ba63f06b8e218fc038c46d6a198df))
* **line:** review a change whose gates pass after they sent it back ([#114](https://github.com/mrogan/cv-software-factory/issues/114)) ([e8f72f3](https://github.com/mrogan/cv-software-factory/commit/e8f72f32e36521dd17b924bc07a091dbcc1fde52))
* **line:** wait at a spend cap instead of failing the step ([#138](https://github.com/mrogan/cv-software-factory/issues/138)) ([09c99e5](https://github.com/mrogan/cv-software-factory/commit/09c99e52aeac586ec383983d70b3f6f27a307175))
* **policy:** name no effort for the local model, and send it none ([#155](https://github.com/mrogan/cv-software-factory/issues/155)) ([a037a0c](https://github.com/mrogan/cv-software-factory/commit/a037a0ccee04d964c7099a539cca7b1c7db58d61))
* **probes:** file a home page link's redirect loop under the route that loops ([#64](https://github.com/mrogan/cv-software-factory/issues/64)) ([b708c6d](https://github.com/mrogan/cv-software-factory/commit/b708c6d07250660df6fd49a6b500ef96d8b4361e))
* **runners:** delete a Job with its pods, and frame every body ([#90](https://github.com/mrogan/cv-software-factory/issues/90)) ([dbb53ee](https://github.com/mrogan/cv-software-factory/commit/dbb53ee5861a6e8dd4d2fc55175f684f4fbde1bb))


### Performance Improvements

* **gates:** observe the base and the change at once, and retry only what failed ([#150](https://github.com/mrogan/cv-software-factory/issues/150)) ([e677059](https://github.com/mrogan/cv-software-factory/commit/e677059f4c14848b113feb84d5ec7756fe9d7d52))

## [0.4.0](https://github.com/mrogan/cv-software-factory/compare/v0.3.1...v0.4.0) (2026-10-04)


### Features

* **console:** show the factory's first real work, sensing and triage ([#51](https://github.com/mrogan/cv-software-factory/issues/51)) ([681386d](https://github.com/mrogan/cv-software-factory/commit/681386dbd113a133d53ec8cd59f33b3eb65128c7))
* **crawler:** check every page and asset any site should pass ([#47](https://github.com/mrogan/cv-software-factory/issues/47)) ([2b6f00c](https://github.com/mrogan/cv-software-factory/commit/2b6f00ca649e19aca4be17b81826c1289fd7f6d5))
* **deploy:** run the factory's workers on the local cluster ([#49](https://github.com/mrogan/cv-software-factory/issues/49)) ([dd31af7](https://github.com/mrogan/cv-software-factory/commit/dd31af7fab2c40d15fee476f8c6737cf8b8fd459))
* **events:** settle version 1 of the events and the store before real work ([#41](https://github.com/mrogan/cv-software-factory/issues/41)) ([6d389c7](https://github.com/mrogan/cv-software-factory/commit/6d389c7e809a685b79afd7b84e0dc61746a1b5c1))
* **gateway:** make the gateway the only way to a model ([#42](https://github.com/mrogan/cv-software-factory/issues/42)) ([d6d60c9](https://github.com/mrogan/cv-software-factory/commit/d6d60c989259f23056f1bb9db0735279d6ea06a4))
* **probes:** look after the shop the way a shopper does ([#46](https://github.com/mrogan/cv-software-factory/issues/46)) ([82f4baa](https://github.com/mrogan/cv-software-factory/commit/82f4baaf99dbaca892a7af4992b0a94be9d873aa))
* **telemetry:** alert on the app's objectives and watch its logs ([#48](https://github.com/mrogan/cv-software-factory/issues/48)) ([19d3fbd](https://github.com/mrogan/cv-software-factory/commit/19d3fbdc6ffd0b1304465e8ec4d8745ac0449028))
* **triage:** turn the inbox into deduplicated tickets ([#44](https://github.com/mrogan/cv-software-factory/issues/44)) ([952ccf8](https://github.com/mrogan/cv-software-factory/commit/952ccf88d01c9f4467cbd1ad5bdbc26380211813))

## [0.3.1](https://github.com/mrogan/cv-software-factory/compare/v0.3.0...v0.3.1) (2026-10-03)


### Bug Fixes

* **console:** decode page thumbnails with the frame that draws them ([#35](https://github.com/mrogan/cv-software-factory/issues/35)) ([1f14f44](https://github.com/mrogan/cv-software-factory/commit/1f14f44604bfe052d21207104e4b63377136fac3))
* **samples:** make samples installs what it needs on a fresh clone ([#34](https://github.com/mrogan/cv-software-factory/issues/34)) ([224338c](https://github.com/mrogan/cv-software-factory/commit/224338c3a5a1e4d2928dc499ca0d0ea36266268d))

## [0.3.0](https://github.com/mrogan/cv-software-factory/compare/v0.2.0...v0.3.0) (2026-10-03)


### Features

* **deploy:** run the console against the event store on the local cluster ([#31](https://github.com/mrogan/cv-software-factory/issues/31)) ([574f10c](https://github.com/mrogan/cv-software-factory/commit/574f10ce56daf387a2594a47119ab5037dec7fed))
* the event store and the console, fed from samples ([#30](https://github.com/mrogan/cv-software-factory/issues/30)) ([bc0bf88](https://github.com/mrogan/cv-software-factory/commit/bc0bf88d1f6f22f838ac1c3a94c072cf00a2376f))

## [0.2.0](https://github.com/mrogan/cv-software-factory/compare/v0.1.1...v0.2.0) (2026-10-02)


### Features

* **deploy:** run The World's Worst Website on the local cluster ([#24](https://github.com/mrogan/cv-software-factory/issues/24)) ([21149b8](https://github.com/mrogan/cv-software-factory/commit/21149b898b5fdc1a3bd5f7834becb5a818d27424))

## [0.1.1](https://github.com/mrogan/cv-software-factory/compare/v0.1.0...v0.1.1) (2026-09-30)


### Bug Fixes

* **deploy:** make up waits until everything is deployed ([#13](https://github.com/mrogan/cv-software-factory/issues/13)) ([ad58072](https://github.com/mrogan/cv-software-factory/commit/ad58072921376573e9bbe946cf260cd685e11a65))

## 0.1.0 (2026-09-30)


### Features

* lay the foundations ([5479643](https://github.com/mrogan/cv-software-factory/commit/54796434c4b777b54e2127aaffe4388df9ede305))


### Bug Fixes

* **ci:** let the first bot pull requests through their checks ([#4](https://github.com/mrogan/cv-software-factory/issues/4)) ([5e56636](https://github.com/mrogan/cv-software-factory/commit/5e5663605bc62bef4a726a7a35e55d500ffafa17))
* **ci:** sign the deploy commit, so main accepts it ([#9](https://github.com/mrogan/cv-software-factory/issues/9)) ([457e566](https://github.com/mrogan/cv-software-factory/commit/457e5668414e5a4c882c8c9920c11af269687dc1))
* **ci:** stop dispatching checks that never count ([#11](https://github.com/mrogan/cv-software-factory/issues/11)) ([806e902](https://github.com/mrogan/cv-software-factory/commit/806e902a5065b0ad88889982de56e9bc13006ff0))
* **release:** start at 0.1.0, and leave release-please's manifest alone ([#8](https://github.com/mrogan/cv-software-factory/issues/8)) ([150c87b](https://github.com/mrogan/cv-software-factory/commit/150c87b048cf2fcf067c955f15ffaa0339fb8957))
