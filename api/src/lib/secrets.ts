/**
 * @fileoverview SecureString parameters (Turnstile secret, session HMAC key), cached per Lambda
 * container for 5 minutes so a rotated value is picked up without a redeploy.
 */
import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { ttlCache } from './gate.js';

const ssm = new SSMClient({});
const cache = ttlCache<string>(5 * 60_000);

/** Returns a SecureString parameter's value; throws if it is empty (a deployment bug). */
export function getSecret(paramName: string): Promise<string> {
  return cache(paramName, async () => {
    const res = await ssm.send(new GetParameterCommand({ Name: paramName, WithDecryption: true }));
    const value = res.Parameter?.Value;
    if (!value) throw new Error(`SSM parameter ${paramName} is empty`);
    return value;
  });
}
