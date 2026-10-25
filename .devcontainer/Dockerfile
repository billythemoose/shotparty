# Everything `npm run setup` and the checks need, preinstalled: Node 22, the AWS CLI, the SAM CLI,
# cfn-lint and shellcheck. Versions of SAM and cfn-lint match CI (.github/workflows/ci.yml).
FROM mcr.microsoft.com/devcontainers/javascript-node:22-bookworm

ARG SAM_VERSION=1.166.2
ARG CFN_LINT_VERSION=1.57.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends pipx shellcheck unzip \
  && rm -rf /var/lib/apt/lists/*

# AWS CLI v2 (the official installer; x86_64 or arm64 to match the host).
RUN arch="$(uname -m)" \
  && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-${arch}.zip" -o /tmp/awscli.zip \
  && unzip -q /tmp/awscli.zip -d /tmp \
  && /tmp/aws/install \
  && rm -rf /tmp/aws /tmp/awscli.zip

# SAM CLI and cfn-lint, each in its own virtualenv, on everyone's PATH.
ENV PIPX_HOME=/opt/pipx PIPX_BIN_DIR=/usr/local/bin
RUN pipx install "aws-sam-cli==${SAM_VERSION}" \
  && pipx install "cfn-lint==${CFN_LINT_VERSION}"
