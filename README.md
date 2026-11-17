# AI-in-One v2.0.1-preview

**Preview for the notebook-backed Fabric OneLake edition only.**

This update addresses [issue #85](https://github.com/microsoft/AI-in-One-Dashboard/issues/85): valid prompts with genuinely missing conversation IDs remain counted, while session-dependent metrics stay blank where conversation attribution is incomplete. Missing or invalid prompt message IDs and invalid nonblank keys remain validation errors.

**[Download the preview ZIP](https://github.com/microsoft/AI-in-One-Dashboard/releases/download/v2.0.1-preview/AI-in-One-v2.0.1-preview-Fabric-OneLake.zip)**

The ZIP contains the preparation notebook and matching Power BI template. Keep the previous pair for rollback and update **both files together**. Use your existing notebook parameters and default Lakehouse, run preparation with valid inputs, then load the matching template after SQL synchronization.

Production and the other editions remain at v2.0.0. This is not the direct Fabric-PAX edition.

[Production downloads and setup](https://aka.ms/AI-in-One) | [Feedback on issue #85](https://github.com/microsoft/AI-in-One-Dashboard/issues/85)
