# AWS Setup

shotparty runs in one AWS account. There are two ways to provide it:

- **[Single account (default)](#single-account-default):** use any account you can log in to. It's the quickest way and it's enough for most people.
- **[Hardened (optional)](#hardened-optional):** a dedicated member account in an AWS Organization, with a service control policy (SCP) that denies every region except yours. If credentials ever leak, the damage stays in one small account and one region. It's a manual checklist.

Either way, all of it is $0/month. Both paths also need the [account requirements](#account-requirements-both-paths) below.

> Conventions: **MGMT** means signed in to your *management (payer) account* as an admin user or role, not the root email login unless a step says so. **MEMBER** means the account shotparty runs in. The region is `aws.region` in the config, **us-east-1** unless you changed it.

---

## Prerequisites (local machine)

`npm run setup` checks for all of these before it touches AWS:

- [ ] **Node 22 or later** (the version in `.nvmrc`; with nvm, run `nvm use`), then install the repo's packages from the repo root:
  ```sh
  npm install
  ```
- [ ] The AWS tools:
  ```sh
  brew install awscli aws-sam-cli cfn-lint
  ```
- [ ] `python3` and `openssl`. Both come with macOS and most Linux distributions.
- [ ] Confirm they work:
  ```sh
  node --version       # v22 or later
  aws --version        # aws-cli/2.x
  sam --version        # SAM CLI, version 1.x
  cfn-lint --version
  python3 --version
  openssl version
  ```

## Account requirements (both paths)

- [ ] **Permissions:** the login you deploy with needs broad rights. A deploy creates IAM roles, Lambda functions, an HTTP API, CloudFront, S3 buckets, a DynamoDB table, SSM parameters, SNS, CloudWatch alarms and a budget. `AdministratorAccess` is the simple choice.
- [ ] **Account plan:** in **Billing → Account plan** (for a member account, check the management account, which pays), confirm the account is on a **paid plan**, not the "Free plan" AWS introduced in July 2025. Accounts on the Free plan can't subscribe to CloudFront flat-rate plans, which is how shotparty gets its WAF and rate limiting at no cost. Without one, everything else still works, but the edge protection is missing.
- [ ] **Lambda concurrency quota:** each stage reserves 205 concurrent executions (presign 100, validate 50, session 25, event 25, health 5), and Lambda always keeps 100 unreserved. The account limit must therefore be at least **305 for one stage, or 510 for dev and prod**. New accounts often start at **10**, and then the app stack deploy fails. Check the current limit:
  ```sh
  aws lambda get-account-settings --profile shotparty --region <region> \
    --query AccountLimit.ConcurrentExecutions
  ```
  If it's below what you need, request the standard 1,000 (approval can take from minutes to a few days):
  ```sh
  aws service-quotas request-service-quota-increase --service-code lambda \
    --quota-code L-B99A9384 --desired-value 1000 --profile shotparty --region <region>
  ```
  Console equivalent: **Service Quotas → AWS services → AWS Lambda → Concurrent executions → Request increase at account level**. The quota is per region, so request it in `aws.region`.

## Single account (default)

- [ ] Get a CLI login to the account. IAM Identity Center (SSO) is best, since it needs no long-lived keys:
  ```sh
  aws configure sso --profile shotparty
  aws sso login --profile shotparty
  ```
  An IAM user's access keys also work, but keep them out of the repo and rotate them.
- [ ] In `shotparty.config.json`, set `aws.profile` to that profile, and `aws.region` if it isn't us-east-1.
- [ ] Optionally set `budgets.accountMonthlyUsd` (default $20). Setup creates a monthly cost budget for the whole account in its own stack. Budgets without actions are free.
- [ ] Check the [account requirements](#account-requirements-both-paths), then run `npm run setup` (see the README).

---

## Hardened (optional)

What you get:
- a dedicated member account for shotparty, in an OU (`Workloads`)
- the region-deny SCP ([`infra/org/scp-region-deny.json`](../infra/org/scp-region-deny.json)) attached to that OU. Global services such as IAM, CloudFront, Route 53, Billing and SSO keep working.
- IAM Identity Center logins with MFA, and no root credentials or long-lived keys for the member account

It's a one-time checklist of 45–60 minutes in the console, with a CLI equivalent for most steps. It isn't scripted: the steps need admin rights over the whole Organization, and some can't be undone quickly (closing an account takes 90 days), so they're best done by hand.

### H1: Check the Organization (MGMT)

- [ ] No Organization yet? **AWS Organizations → Create an organization** (or `aws organizations create-organization --feature-set ALL`). The account you're signed in to becomes the management account.
- [ ] **AWS Organizations** console: confirm the organization exists and **Settings** shows **All features** enabled. SCPs need all features, not just consolidated billing.
- [ ] Confirm the management account is on a paid plan (see [account requirements](#account-requirements-both-paths)).

### H2: Centralize root access (MGMT), before creating the account

Doing this first means the new account is created **with no root credentials at all**.

- [ ] **IAM console → Root access management → Enable**. Turn on both **Root credentials management** and **Privileged root actions in member accounts**.
  - CLI equivalent:
    ```sh
    aws organizations enable-aws-service-access --service-principal iam.amazonaws.com
    aws iam enable-organizations-root-credentials-management
    aws iam enable-organizations-root-sessions
    ```

### H3: Create the OU and the account (MGMT)

- [ ] Pick an email for the new account. It must be unique across AWS. A plus-alias works: `yourname+shotparty@gmail.com`.
- [ ] **Organizations → AWS accounts → Root → Actions → Create new** organizational unit named **`Workloads`**.
- [ ] **Add an AWS account → Create an AWS account**:
  - Account name: **`shotparty`**
  - Email: the alias above
  - IAM role name: leave the default `OrganizationAccountAccessRole`
- [ ] Wait for the status to become *Active* (1–5 min), then **move** the account into the `Workloads` OU.
- [ ] Write down the new **12-digit account ID**: `____________`
  - CLI equivalent:
    ```sh
    aws organizations create-account --email you+shotparty@gmail.com --account-name shotparty
    aws organizations describe-create-account-status --create-account-request-id <id>
    aws organizations move-account --account-id <new-id> --source-parent-id <root-id> --destination-parent-id <workloads-ou-id>
    ```

### H4: Region-deny SCP (MGMT)

This limits everything in `Workloads` to **us-east-1**, except global services. For another region, change `aws:RequestedRegion` in a copy of the policy (and the `Sid`, for readability).

- [ ] **Organizations → Policies → Service control policies → Enable** (if it isn't already enabled).
- [ ] **Create policy**:
  - Name: `shotparty-region-deny-us-east-1`
  - Paste the JSON from the repo file
- [ ] **Attach** it to the **`Workloads` OU**, not the root and not the management account: open the policy → **Targets → Attach** → `Workloads`.
- [ ] Confirm it's attached: **Workloads OU → Policies** tab lists `shotparty-region-deny-us-east-1`. Creating the policy doesn't attach it, and an unattached SCP does nothing.
  - CLI equivalent:
    ```sh
    aws organizations create-policy --type SERVICE_CONTROL_POLICY \
      --name shotparty-region-deny-us-east-1 \
      --description "Deny all regions except us-east-1 (global services exempt)" \
      --content file://infra/org/scp-region-deny.json
    aws organizations attach-policy --policy-id <p-xxxx> --target-id <workloads-ou-id>
    ```
- Note: if something later hits an unexpected `AccessDenied ... explicit deny in a service control policy` for a global service, add that service to `NotAction` in the policy and re-apply it.

### H5: IAM Identity Center logins with MFA (MGMT)

- [ ] **IAM Identity Center** console, with the region selector set to **us-east-1**: **Enable**, choosing the organization instance.
- [ ] **Settings → Authentication → Multi-factor authentication → Configure**, before adding users:
  - Prompt users for MFA: **Every time they sign in (always-on context)**
  - Users can authenticate with: tick **both** (authenticator apps, and security keys / built-in authenticators)
  - If a user does not yet have a registered MFA device: **Require them to register an MFA device at sign in**
- [ ] **Users → Add user** for yourself (Identity Center's built-in directory is fine). Accept the email invite and set a password.
- [ ] Find the **AWS access portal URL** on the Identity Center **Dashboard → Settings summary** (e.g. `https://d-xxxxxxxxxx.awsapps.com/start`). Sign in there and **register MFA** when prompted.
  - Not prompted? In the portal, go to **your username (top right) → MFA devices → Register device**.
  - Confirm under **Users → your user → MFA devices**. Registering two devices (e.g. a passkey and an authenticator app) avoids lock-out.
- [ ] **Permission sets → Create → Predefined → `AdministratorAccess`**, with a session duration of **8 hours**.
- [ ] **AWS accounts → select `shotparty` → Assign users or groups** → your user and `AdministratorAccess`.
- [ ] Note the access portal URL for H6: `____________`
- Optional: also assign your user + `AdministratorAccess` to the **management account** (**AWS accounts → management account → Assign users or groups**). One MFA login then covers both accounts. Add a CLI profile with `aws configure sso --profile mgmt`, reusing the same SSO session, and retire old IAM-user keys. Keep the root login (with MFA) stored safely as an emergency backup only.

### H6: CLI profile (local)

- [ ] Run:
  ```sh
  aws configure sso --profile shotparty
  ```
  Enter these answers:
  - SSO session name: `shotparty`
  - SSO start URL: the portal URL from H5
  - SSO region: `us-east-1` (where Identity Center was enabled in H5)
  - Registration scopes: accept the default
  - The browser opens: approve it
  - Choose the **shotparty** account and the **AdministratorAccess** role
  - Default region: your `aws.region` (the scripts always pass the config's region, so this only affects your own CLI use)
  - Output format: `json`
- [ ] Future logins are just:
  ```sh
  aws sso login --profile shotparty
  ```

### Verify

Replace `us-east-1` with your region if you changed it, and `eu-west-1` with any region outside the SCP's allow list.

```sh
aws sso login --profile shotparty

# 1. You are in the NEW account (the Account field matches H3), via SSO (the Arn contains AWSReservedSSO_AdministratorAccess)
aws sts get-caller-identity --profile shotparty

# 2. Your region works (returns {"TableNames": [...]})
aws dynamodb list-tables --profile shotparty --region us-east-1

# 3. Other regions are blocked by the SCP (AccessDeniedException ... explicit deny in a service control policy)
aws dynamodb list-tables --profile shotparty --region eu-west-1

# 4. No long-lived keys on disk for this profile (prints nothing)
grep -A3 '\[shotparty\]' ~/.aws/credentials 2>/dev/null
```

- [ ] All four checks match the expected results.
- [ ] Optional: IAM console in MGMT → **Root access management** lists `shotparty` with **no root credentials** present.

Then:
- [ ] A new member account almost always starts with a Lambda concurrency limit of 10: request the increase described in [account requirements](#account-requirements-both-paths), and wait for it to be approved.
- [ ] Set `aws.profile` to `shotparty` in the config and run `npm run setup` (it also creates the account's monthly budget).

## Troubleshooting

**`Specified ReservedConcurrentExecutions for function decreases account's UnreservedConcurrentExecution below its minimum value`** when the app stack deploys:
- The account's Lambda concurrency limit is too low for the reserved concurrency. Request the increase in [account requirements](#account-requirements-both-paths), wait for approval, and run `npm run setup` again; it resumes where it stopped.

**`SubscriptionRequiredException: The AWS Access Key Id needs a subscription for the service`** on every service call (DynamoDB, Budgets, Cost Explorer) in a new member account:
- The account has **not finished activating**. Organizations can show it as **Active** while AWS is still enabling services in the background. This can take up to about 24 h. `sts get-caller-identity` still works, because STS doesn't need activation.
- Check that the management account's **Billing → Payment preferences** has a valid, verified payment method (it pays for all member accounts through consolidated billing), and look for activation or verification emails sent to the account's email alias.
- If it's still failing after about 24 h: from the management account, go to **Support Center → Create case → Account and billing → Account → Activation**. Give the account ID and the exact error.

**`AccessDenied ... explicit deny in a service control policy`** for a service in your own region: the SCP's `aws:RequestedRegion` doesn't match `aws.region` in the config. Fix whichever one is wrong.
