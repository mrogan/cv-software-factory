# Changelog

## [0.7.0](https://github.com/mrogan/cv-software-factory/compare/v0.6.0...v0.7.0) (2026-10-17)


### Features

* **console:** list a station's work in hand first, marked as the station marks itself ([#319](https://github.com/mrogan/cv-software-factory/issues/319)) ([aedb0ac](https://github.com/mrogan/cv-software-factory/commit/aedb0acf43799d02677ef5104dd152580eb92a02))
* **console:** say both versions' figures beside a failed measure's excess ([#318](https://github.com/mrogan/cv-software-factory/issues/318)) ([a961667](https://github.com/mrogan/cv-software-factory/commit/a961667b2c1a83de79c348d815f57b9523e2514b))
* **line:** give the describer the description rules /visual-pr follows ([#349](https://github.com/mrogan/cv-software-factory/issues/349)) ([eef5abe](https://github.com/mrogan/cv-software-factory/commit/eef5abe8fbd536cada1339ad5346028940b8d63f))
* **line:** have the coder take or decline the reviewer's suggestions ([#274](https://github.com/mrogan/cv-software-factory/issues/274)) ([0f6d6d5](https://github.com/mrogan/cv-software-factory/commit/0f6d6d5ab39f73f0dce807e7e0d068e18a857ab5))
* **line:** have the planner quote the words each criterion comes from ([#339](https://github.com/mrogan/cv-software-factory/issues/339)) ([fb81865](https://github.com/mrogan/cv-software-factory/commit/fb81865bb378ea56ce506459770cdd10bae63906))
* **release:** count a rolled-back measure's failed looks, and say it on the Canary panel ([#341](https://github.com/mrogan/cv-software-factory/issues/341)) ([92d9f0e](https://github.com/mrogan/cv-software-factory/commit/92d9f0ebd15b7213d2789d36c5a624d276359009))
* **release:** record an aborted release, so a stop is not inferred ([#271](https://github.com/mrogan/cv-software-factory/issues/271)) ([943aade](https://github.com/mrogan/cv-software-factory/commit/943aade0eb1260773b106790f4ea72efbc4447f5))
* **release:** record an analysis that could not judge the canary as an end of its own ([#320](https://github.com/mrogan/cv-software-factory/issues/320)) ([c2ad85b](https://github.com/mrogan/cv-software-factory/commit/c2ad85bd80d6b2bbc09e3357e7507c5a24bd26ee))
* **skills:** add /implement, which takes issues or a brief to pull requests ([#334](https://github.com/mrogan/cv-software-factory/issues/334)) ([b568b0d](https://github.com/mrogan/cv-software-factory/commit/b568b0d4f9ba7b0ccb0b51ea108e8275d88c33d8))
* **skills:** have visual-pr show a change's snapshots before and after ([#301](https://github.com/mrogan/cv-software-factory/issues/301)) ([c3c7477](https://github.com/mrogan/cv-software-factory/commit/c3c74779558280d267780474b47d7dce1a523436))
* **skills:** have visual-pr show a changed snapshot as a blink ([#344](https://github.com/mrogan/cv-software-factory/issues/344)) ([43f9192](https://github.com/mrogan/cv-software-factory/commit/43f91926919b913af6598e3ac42d1a7cb90c8a05))
* **skills:** have visual-pr write shorter descriptions and fold supporting sections ([#345](https://github.com/mrogan/cv-software-factory/issues/345)) ([eeaa016](https://github.com/mrogan/cv-software-factory/commit/eeaa01632c2fb229399ec51a7b2a609cda4322e1))
* **triage:** hold a burst of new problems from one sense for Martin ([#330](https://github.com/mrogan/cv-software-factory/issues/330)) ([34fe72c](https://github.com/mrogan/cv-software-factory/commit/34fe72c6672c3a13e7458f44868277a93b7f17aa))
* **triage:** hold a sense's new problem while what it reads is unhealthy ([#342](https://github.com/mrogan/cv-software-factory/issues/342)) ([ea3d78d](https://github.com/mrogan/cv-software-factory/commit/ea3d78d498ce456934bd7e238c15953786a1bc99))
* **triage:** record a signal seen again in a new version on its open ticket ([#266](https://github.com/mrogan/cv-software-factory/issues/266)) ([bf1d3fd](https://github.com/mrogan/cv-software-factory/commit/bf1d3fd96eb4ad3af270a67dd601f79dbc8ac38b))


### Bug Fixes

* call the app the app in the agents' prompts and triage's questions ([#331](https://github.com/mrogan/cv-software-factory/issues/331)) ([4b8b7e4](https://github.com/mrogan/cv-software-factory/commit/4b8b7e4388a401af53cfb8e1d2549dbccbbe035f))
* call the app the app, not the shop, in the factory's code, console and docs ([#321](https://github.com/mrogan/cv-software-factory/issues/321)) ([7e2d314](https://github.com/mrogan/cv-software-factory/commit/7e2d31410673f8ecae2dba2ab25044ba9dcc3741))
* **console:** count a sheet's event times in days past a day, in a column sized to hold them ([#304](https://github.com/mrogan/cv-software-factory/issues/304)) ([1608e85](https://github.com/mrogan/cv-software-factory/commit/1608e8553e2050478a35ff2932a1df5ed7622c09))
* **console:** count a sheet's reviews in the pass the line limits them by ([#308](https://github.com/mrogan/cv-software-factory/issues/308)) ([d2aba71](https://github.com/mrogan/cv-software-factory/commit/d2aba7146bdcb092208046dfd66f628b0849613f))
* **console:** don't render the reel to stop a history that isn't playing ([#254](https://github.com/mrogan/cv-software-factory/issues/254)) ([202222e](https://github.com/mrogan/cv-software-factory/commit/202222e6d9967339f1f53886bbf7c17b9b871f8e))
* **console:** draw a rollback's marker label over the plot, clear of the end labels ([#307](https://github.com/mrogan/cv-software-factory/issues/307)) ([350151e](https://github.com/mrogan/cv-software-factory/commit/350151e03b9417a1fa773037eab7ddd03747bb9b))
* **console:** draw the Canary panel's measures waiting before the first step is measured ([#340](https://github.com/mrogan/cv-software-factory/issues/340)) ([cc4aa05](https://github.com/mrogan/cv-software-factory/commit/cc4aa05d848fe5784ffcd491d05c5932bfdb8c53))
* **console:** show a window of the timeline, and say its versions in words ([#353](https://github.com/mrogan/cv-software-factory/issues/353)) ([8385752](https://github.com/mrogan/cv-software-factory/commit/83857521c35ef6ed8c6bd0b12785bc553f74cfb4))
* **console:** write a commit by its first seven characters under the timeline ([#303](https://github.com/mrogan/cv-software-factory/issues/303)) ([3242b48](https://github.com/mrogan/cv-software-factory/commit/3242b488e8f37d6bdfd234307312cfb9bed595d6))
* **console:** write a duration as one value, 5d 1h rather than 5 d 1 h ([#300](https://github.com/mrogan/cv-software-factory/issues/300)) ([f7874e1](https://github.com/mrogan/cv-software-factory/commit/f7874e1d4102512aed416775e7cfb5b407b67a86))
* **deploy:** give the GitHub worker the memory a merge needs ([#368](https://github.com/mrogan/cv-software-factory/issues/368)) ([4442b38](https://github.com/mrogan/cv-software-factory/commit/4442b3865720c2af9b74b6e79b8c11899b45dff5))
* **deploy:** have the factory read telemetry through a read-only proxy ([#351](https://github.com/mrogan/cv-software-factory/issues/351)) ([d123f8f](https://github.com/mrogan/cv-software-factory/commit/d123f8fc5464a929ed15b1d0485aaefaece08741))
* **deploy:** have the intake and the log watcher name each telemetry backend's pods ([#350](https://github.com/mrogan/cv-software-factory/issues/350)) ([a6cd286](https://github.com/mrogan/cv-software-factory/commit/a6cd28614b1aa25117dd301bfaa231d91e606147))
* **deploy:** let the line read Tempo, for Verify's agreement check ([#333](https://github.com/mrogan/cv-software-factory/issues/333)) ([ff34c03](https://github.com/mrogan/cv-software-factory/commit/ff34c032be158b741ed1606090fb95794f4e0fdb))
* **egress:** report a failed exec as that check's FAIL, and wait for rollouts ([#361](https://github.com/mrogan/cv-software-factory/issues/361)) ([e03cbc1](https://github.com/mrogan/cv-software-factory/commit/e03cbc15cb9ce014173e1bf0c4a028ad9a6d8ef2))
* **egress:** run each worker's checks from a probe pod made from its Deployment ([#366](https://github.com/mrogan/cv-software-factory/issues/366)) ([c80f786](https://github.com/mrogan/cv-software-factory/commit/c80f786d347cebab8655a6b77699c608acd4dbb7))
* **line:** cut a planner finding's page and route at their query instead of refusing the result ([#338](https://github.com/mrogan/cv-software-factory/issues/338)) ([2f0f0e8](https://github.com/mrogan/cv-software-factory/commit/2f0f0e80155f1152a01ce7335a69101c999b81c3))
* **line:** resolve the threads of findings a later review finds answered ([#264](https://github.com/mrogan/cv-software-factory/issues/264)) ([57a098c](https://github.com/mrogan/cv-software-factory/commit/57a098c5f6e001617be80778565ee324f71cb286))
* **line:** verify a missing-log or wrong-metric ticket by the agreement check ([#329](https://github.com/mrogan/cv-software-factory/issues/329)) ([fd4ce91](https://github.com/mrogan/cv-software-factory/commit/fd4ce9119cdd5d95c928788eb6a4a3d76499c999))
* **logs:** count the agreement check's traces with a TraceQL metrics query ([#369](https://github.com/mrogan/cv-software-factory/issues/369)) ([ac25bfa](https://github.com/mrogan/cv-software-factory/commit/ac25bfa58f3a14fa5a177aa713b13ac470543978))
* **logs:** learn the day's error patterns a page at a time, with only the fields read ([#367](https://github.com/mrogan/cv-software-factory/issues/367)) ([5e22f61](https://github.com/mrogan/cv-software-factory/commit/5e22f617e659e4477f712ffce772d0178f65d16a))
* **logs:** one ticket for a gap in the log, not one per page ([#326](https://github.com/mrogan/cv-software-factory/issues/326)) ([bf69135](https://github.com/mrogan/cv-software-factory/commit/bf69135e0168eb7d512426760f813bb78e6667c6))
* **pictures:** box every element the senses boxed on a page ([#262](https://github.com/mrogan/cv-software-factory/issues/262)) ([f523017](https://github.com/mrogan/cv-software-factory/commit/f523017a8ec585e08ba44dcbb7c64ef1bd26ad7a))
* **release:** name a release by its hash and the Rollout's revision ([#265](https://github.com/mrogan/cv-software-factory/issues/265)) ([3005fa1](https://github.com/mrogan/cv-software-factory/commit/3005fa1f4ee2d99c72fee10fc611f4ba99011fff))
* **release:** record a background rollback at the weight the canary reached ([#310](https://github.com/mrogan/cv-software-factory/issues/310)) ([ee482a1](https://github.com/mrogan/cv-software-factory/commit/ee482a1e089fbabebf228689531ecb2ca09d7cab))
* **release:** record a missed release of an image promoted before ([#311](https://github.com/mrogan/cv-software-factory/issues/311)) ([f5324ae](https://github.com/mrogan/cv-software-factory/commit/f5324aee34dff46c086bfac5de7651a3a477fcb2))
* **samples:** send an approval's suggestions back to the coder, as the line does ([#309](https://github.com/mrogan/cv-software-factory/issues/309)) ([ce1ce2d](https://github.com/mrogan/cv-software-factory/commit/ce1ce2d7bbc20eccd16ac2b786df5de8edfffa51))
* **senses:** leave the senses' requests out of the app's figures ([#263](https://github.com/mrogan/cv-software-factory/issues/263)) ([9e6fb79](https://github.com/mrogan/cv-software-factory/commit/9e6fb7933c14885b05c97e5e281dd0ec43267efc))
* **senses:** read as the app's only the telemetry the collector stamped ([#354](https://github.com/mrogan/cv-software-factory/issues/354)) ([81dd731](https://github.com/mrogan/cv-software-factory/commit/81dd731084c7938877a1e7547da0367ae3092287))
* **store:** remove the test Postgres's data volume with its container ([#295](https://github.com/mrogan/cv-software-factory/issues/295)) ([4b41abc](https://github.com/mrogan/cv-software-factory/commit/4b41abc09b7cba958aad7f88a59eb052b21ebdae))


### Performance Improvements

* **console:** run the console on Preact, at half the JavaScript ([#284](https://github.com/mrogan/cv-software-factory/issues/284)) ([77a3209](https://github.com/mrogan/cv-software-factory/commit/77a3209b571a5ab1b95fdf6856c16c931603594f))

## [0.6.0](https://github.com/mrogan/cv-software-factory/compare/v0.5.0...v0.6.0) (2026-10-13)


### Features

* **admission:** enforce the factory's image policy ([#185](https://github.com/mrogan/cv-software-factory/issues/185)) ([d9441e8](https://github.com/mrogan/cv-software-factory/commit/d9441e8d1e88ca8e581bb46551c0246ad765f5e2))
* **admission:** enforce the website's image policy ([#186](https://github.com/mrogan/cv-software-factory/issues/186)) ([bd11ef3](https://github.com/mrogan/cv-software-factory/commit/bd11ef3b8b98df8ef7ee83aa62576f172d24dc10))
* **console:** draw a release as it ships, in the Canary panel ([#232](https://github.com/mrogan/cv-software-factory/issues/232)) ([fb5ee6d](https://github.com/mrogan/cv-software-factory/commit/fb5ee6d4a66fbd6ee71bbdc1eb2652ee7a0ae42e))
* **console:** mark each release's version on the timeline, one with no work item at its time ([#237](https://github.com/mrogan/cv-software-factory/issues/237)) ([29f60a0](https://github.com/mrogan/cv-software-factory/commit/29f60a0cdd54c3c2eb27695f43421ef415cb9e7b))
* **console:** show the scoreboard beside the app's name ([#233](https://github.com/mrogan/cv-software-factory/issues/233)) ([b588c14](https://github.com/mrogan/cv-software-factory/commit/b588c14b648ba4c72fed47f490b3628be8e9ac77))
* **console:** tell a work item's releases and verification on its sheet ([#234](https://github.com/mrogan/cv-software-factory/issues/234)) ([e8ca520](https://github.com/mrogan/cv-software-factory/commit/e8ca520952136f4edcf4a93e007a0331698c394c))
* **deploy:** admit only images their pipeline signed, with Kyverno ([#174](https://github.com/mrogan/cv-software-factory/issues/174)) ([97aa373](https://github.com/mrogan/cv-software-factory/commit/97aa3730ad3110f97653c38fb68b8e4f4b99c1ab))
* **deploy:** install Argo Rollouts, and label the app's telemetry by version ([#170](https://github.com/mrogan/cv-software-factory/issues/170)) ([fb81c57](https://github.com/mrogan/cv-software-factory/commit/fb81c57ae0bf11e6910052b1a3950ff329588747))
* **deploy:** run the scoreboard in its own namespace, fenced ([#224](https://github.com/mrogan/cv-software-factory/issues/224)) ([fd4e486](https://github.com/mrogan/cv-software-factory/commit/fd4e4863d9638217b42171bd6880792111d27051))
* **deploy:** run the traffic generator in the cluster ([#172](https://github.com/mrogan/cv-software-factory/issues/172)) ([41bffca](https://github.com/mrogan/cv-software-factory/commit/41bffcade590e825db188fd9614cc8120fdf8fa5))
* **github:** say what a deploy pull request carries ([#192](https://github.com/mrogan/cv-software-factory/issues/192)) ([94ac7ea](https://github.com/mrogan/cv-software-factory/commit/94ac7ea8f525476008e569801f5f9d97610f943a))
* **github:** sign every image, and propose only what the pipeline signed ([#169](https://github.com/mrogan/cv-software-factory/issues/169)) ([7ba69d6](https://github.com/mrogan/cv-software-factory/commit/7ba69d6929222714bd83a11738086587c7ed1038))
* **line:** abort a canary when the line stops, and fence the release ([#175](https://github.com/mrogan/cv-software-factory/issues/175)) ([f150844](https://github.com/mrogan/cv-software-factory/commit/f150844348c54c1b37a788df9b183f9a83b28068))
* **line:** carry a merged work item to Release and Verify ([#191](https://github.com/mrogan/cv-software-factory/issues/191)) ([6252b0c](https://github.com/mrogan/cv-software-factory/commit/6252b0ca35a4121cf7281ed5affed37616dbd976))
* **line:** record the canary's steps when a release starts ([#219](https://github.com/mrogan/cv-software-factory/issues/219)) ([425c141](https://github.com/mrogan/cv-software-factory/commit/425c1415180dcda9fa138d0f835c9259b3280aec))
* **line:** turn a failed canary analysis into a signal ([#201](https://github.com/mrogan/cv-software-factory/issues/201)) ([7b81a2d](https://github.com/mrogan/cv-software-factory/commit/7b81a2d2faf61a007f9e32c34f59b7e3089bbe79))
* **line:** verify a release by the sense that saw the defect ([#194](https://github.com/mrogan/cv-software-factory/issues/194)) ([2b6b69f](https://github.com/mrogan/cv-software-factory/commit/2b6b69f0e1997c4c5c610206047c1cf5476dd806))
* **line:** watch the app's release, read-only ([#193](https://github.com/mrogan/cv-software-factory/issues/193)) ([07d5ac2](https://github.com/mrogan/cv-software-factory/commit/07d5ac2c56b2519c34ddb550f23ca8eeddacda27))
* **pictures:** delete pictures no release needs ([#221](https://github.com/mrogan/cv-software-factory/issues/221)) ([cafd755](https://github.com/mrogan/cv-software-factory/commit/cafd755451217acefa6d1649e50788c331612062))
* **probes:** compare every page on the stable and the canary ([#196](https://github.com/mrogan/cv-software-factory/issues/196)) ([f800eb3](https://github.com/mrogan/cv-software-factory/commit/f800eb329f2b785f5d1319d5d86298814b16d8eb))
* **release:** judge the app's canary against its baseline, with traffic to judge by ([#171](https://github.com/mrogan/cv-software-factory/issues/171)) ([5a0d6fc](https://github.com/mrogan/cv-software-factory/commit/5a0d6fcfddb0f2cd9d0b310f736fbc85a5b0c185))
* **samples:** ship the samples' last week as milestone 6's line does ([#231](https://github.com/mrogan/cv-software-factory/issues/231)) ([63fac48](https://github.com/mrogan/cv-software-factory/commit/63fac483d38be3664ff7f2da0993c5d45e487533))
* **scoreboard:** count tickets against the answer key ([#220](https://github.com/mrogan/cv-software-factory/issues/220)) ([ea33ca2](https://github.com/mrogan/cv-software-factory/commit/ea33ca2f491c59dc4dff46c2ffa124b80419d154))
* **triage:** reopen a verified ticket when its signal returns ([#195](https://github.com/mrogan/cv-software-factory/issues/195)) ([04374e5](https://github.com/mrogan/cv-software-factory/commit/04374e52e59142357435378e372f9d16c02f7ce2))


### Bug Fixes

* **admission:** verify the signature only, not the SBOM ([#184](https://github.com/mrogan/cv-software-factory/issues/184)) ([8adc43d](https://github.com/mrogan/cv-software-factory/commit/8adc43d77cc7b2bfb22c98722a4058cb5ae7de57))
* **console:** draw a return only until its work moves on, and boxes where they belong ([#225](https://github.com/mrogan/cv-software-factory/issues/225)) ([ed5c4ce](https://github.com/mrogan/cv-software-factory/commit/ed5c4cec2727ceacdc2cfeeb09835a83a3a6a712))
* **console:** draw the shipping states as the design has them ([#251](https://github.com/mrogan/cv-software-factory/issues/251)) ([2c18148](https://github.com/mrogan/cv-software-factory/commit/2c181484556a601c0f7f8641dd524fb92584d853))
* **deploy:** give the GitHub worker a writable /tmp, which TUF needs ([#187](https://github.com/mrogan/cv-software-factory/issues/187)) ([2e2877f](https://github.com/mrogan/cv-software-factory/commit/2e2877fa029a07f9ff45b1ddceb521f58eaca3f7))
* **egress:** ask about pods' subresources as subresources ([#230](https://github.com/mrogan/cv-software-factory/issues/230)) ([8225dde](https://github.com/mrogan/cv-software-factory/commit/8225ddeb7efd70fe3f007afd667dda385107fea8))
* **github:** find a signature when GHCR's index carries no annotations ([#181](https://github.com/mrogan/cv-software-factory/issues/181)) ([1e44502](https://github.com/mrogan/cv-software-factory/commit/1e44502d1e7ac099a9baa0e41232bc66aa346f1b))
* **pictures:** box only the ticket's own check on its pages ([#218](https://github.com/mrogan/cv-software-factory/issues/218)) ([a0b9b30](https://github.com/mrogan/cv-software-factory/commit/a0b9b30cc8378529bbdb710bbafb3b1d29d10143))
* **release:** keep the factory's own requests out of the canary's figures ([#222](https://github.com/mrogan/cv-software-factory/issues/222)) ([423e33f](https://github.com/mrogan/cv-software-factory/commit/423e33fafd25239b49b3807617e8724b087aeb59))
* show the fixed picture and the right hold on a verified work item's sheet ([#212](https://github.com/mrogan/cv-software-factory/issues/212)) ([d7e4cf7](https://github.com/mrogan/cv-software-factory/commit/d7e4cf735ab0512b4798a93f47029e18e2e328b7))

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
* **probes:** look after the app the way a visitor does ([#46](https://github.com/mrogan/cv-software-factory/issues/46)) ([82f4baa](https://github.com/mrogan/cv-software-factory/commit/82f4baaf99dbaca892a7af4992b0a94be9d873aa))
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
