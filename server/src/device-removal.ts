import { WebSocket } from "ws";
import type { ClientTransport } from "./client-transport";
import { DirectClientTransport } from "./direct-client-transport";
import { DirectV2Transport } from "./direct-v2-transport";
import type { DeviceEntry } from "./device-registry";

/**
 * Removing a key from this computer (`device_remove`), and the capabilities
 * broadcast that the removal sets off. They sit together because the order
 * between them decides whether a removed device learns the new AUTH_TOKEN.
 * index.ts supplies the steps and calls both.
 */

/** What a removal touches. index.ts fills these in from its transports. */
export interface DeviceRemovalSteps {
  /** Closes every channel a device key has open: relay, bulk and both direct paths. */
  dropDeviceChannels(publicKey: string): void;
  rotateAuthToken(): void;
  /** Takes the key out of the registry. The registry then broadcasts capabilities. */
  revoke(publicKey: string): void;
  clearPending(publicKey: string): void;
  renewPairingSecret(): void;
  /** Takes the device's push registrations off this computer's list, and those under no key when [alsoUnkeyed]. */
  dropPushRegistrations(publicKey: string, alsoUnkeyed: boolean): void;
  revokeConnector(publicKey: string): void;
  dropLinkPeers(publicKey: string): void;
}

/**
 * Removes [entry]. For a device its channels close first, then the token
 * changes, then the registry change broadcasts capabilities. That broadcast
 * carries the new AUTH_TOKEN to old-path clients that hold the token, so no
 * socket of the removed device may be open when it goes out. The new pairing
 * secret is made last and reaches only the devices that stay. [keepToken] is
 * Forget: the key goes and the secret is renewed, so the forgotten install
 * cannot pair again with the secret it holds, but AUTH_TOKEN stays.
 *
 * A removed device gets no more notifications: the push registrations stored
 * under its key are dropped. Remove also drops those stored under no key,
 * since the removed phone's may be one of them. Forget leaves those.
 */
export function removeRegisteredKey(entry: DeviceEntry, keepToken: boolean, steps: DeviceRemovalSteps): void {
  const { publicKey } = entry;
  if (entry.kind === "device") {
    steps.dropDeviceChannels(publicKey);
    if (!keepToken) steps.rotateAuthToken();
  }
  steps.revoke(publicKey);
  steps.clearPending(publicKey);
  if (entry.kind === "device") {
    steps.dropPushRegistrations(publicKey, !keepToken);
    steps.renewPairingSecret();
  } else if (entry.kind === "connector") {
    steps.revokeConnector(publicKey);
  } else {
    steps.dropLinkPeers(publicKey);
  }
}

/**
 * Closes what [publicKey] still holds after its record was deleted because
 * its account retired the pass key that vouched for it. The record is
 * already gone, so every step runs: each is keyed, and a key that is a
 * device has no link channel or AI client tokens to lose, and the other way
 * round. A device stops getting notifications, a linked computer's channel
 * closes, and an AI client's tokens stop working at once.
 *
 * Unlike a removal this changes neither AUTH_TOKEN nor the pairing secret:
 * the account's own devices are among the dropped and come straight back.
 */
export function closeDroppedKey(
  publicKey: string,
  steps: Pick<DeviceRemovalSteps, "dropDeviceChannels" | "dropPushRegistrations" | "revokeConnector" | "dropLinkPeers">,
): void {
  steps.dropDeviceChannels(publicKey);
  steps.dropPushRegistrations(publicKey, false);
  steps.revokeConnector(publicKey);
  steps.dropLinkPeers(publicKey);
}

/** The three capability payloads one broadcast chooses between. */
export interface CapabilityPayloads {
  /** For an old-path client that holds AUTH_TOKEN: carries the token and the room. */
  withToken: Record<string, unknown>;
  withoutToken: Record<string, unknown>;
  v2: Record<string, unknown>;
}

/**
 * Sends each open direct client its capabilities. Only an old-path client
 * that may learn the token gets `withToken`, and no v2 client does.
 */
export function broadcastDirectCapabilities(
  clients: ReadonlySet<ClientTransport>,
  payloads: CapabilityPayloads,
  isRecordedDevice: (publicKey: string) => boolean,
): void {
  for (const client of clients) {
    if (client.readyState !== WebSocket.OPEN) continue;
    if (client instanceof DirectV2Transport) client.send(JSON.stringify(payloads.v2));
    else client.send(JSON.stringify(client instanceof DirectClientTransport && client.mayLearnAuthToken(isRecordedDevice) ? payloads.withToken : payloads.withoutToken));
  }
}
