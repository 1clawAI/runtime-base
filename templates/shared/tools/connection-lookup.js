"use strict";

/**
 * Why an OAuth-connection lookup did not produce a connection.
 *
 * `getGitHubConnection` and its twins for Google and Slack returned `null`
 * whether the endpoint answered 4xx/5xx, the call threw, or the agent simply
 * has no such connection — and every caller reported all three as "No GitHub
 * OAuth connection found for this agent". So an expired agent token, a vault
 * error or a network blip all told the user to connect an account that was
 * already connected. They reconnect it, nothing changes, and the real fault is
 * never looked at.
 *
 * The agent relays these to a person, so each one names the provider and says
 * what to do next. Only the genuinely-absent case suggests connecting.
 */
function connectionLookupFailure({ provider, status, threw, absent }) {
  if (absent) {
    return (
      `No ${provider} connection is set up for this agent. Connect ${provider} in ` +
      `Dashboard → Agents → (this agent) → Connections, then try again.`
    );
  }
  if (threw) {
    return (
      `Could not reach the connections API to look up ${provider} (${threw}). ` +
      `This is a transport failure, not a missing connection — ${provider} may well ` +
      `be connected. Retry; if it persists, check the runtime's network egress.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `The connections API rejected this agent's credentials (HTTP ${status}) while ` +
      `looking up ${provider}. This is an authentication problem, not a missing ` +
      `connection. The runtime renews its own token, so retry first; if it keeps ` +
      `happening, Restart the runtime.`
    );
  }
  return (
    `The connections API returned HTTP ${status} while looking up ${provider}, so ` +
    `whether ${provider} is connected is unknown. This is not a sign that it is ` +
    `missing. Retry, and check the runtime's logs if it persists.`
  );
}

/**
 * The same problem for notification channels, in a worse form.
 *
 * `fetchChannels` returned `[]` for any 4xx/5xx, `findChannel` found nothing
 * in it, and the tool reported "No active Telegram channel found. Connect one
 * via the dashboard." An empty list is a stronger claim than a null: it does
 * not say "I could not find it", it says "there are none". So an expired token
 * had the agent assert, confidently, that a channel the user is looking at
 * does not exist.
 */
function channelLookupFailure({ type, status, threw, absent }) {
  if (absent) {
    return (
      `No active ${type} channel is configured for this agent. Connect one in the ` +
      `dashboard, or pass channel_id to use a specific channel.`
    );
  }
  if (threw) {
    return (
      `Could not reach the channels API to find a ${type} channel (${threw}). The ` +
      `channel may well exist — this is a transport failure, not an empty list. Retry.`
    );
  }
  if (status === 401 || status === 403) {
    return (
      `The channels API rejected this agent's credentials (HTTP ${status}), so its ` +
      `${type} channels could not be listed. This does not mean there are none. The ` +
      `runtime renews its own token, so retry; if it persists, Restart the runtime.`
    );
  }
  return (
    `The channels API returned HTTP ${status}, so this agent's ${type} channels ` +
    `could not be listed. Whether one exists is unknown. Retry, and check the ` +
    `runtime's logs if it persists.`
  );
}

module.exports = { connectionLookupFailure, channelLookupFailure };
