import type { RelayLane } from "./device-auth";
import type { RelayClientOptions } from "./relay-client";

/**
 * The options of this computer's relay clients, one per room: control, bulk
 * and link. index.ts builds all three here and nowhere else, so what every
 * lane must have cannot be left off one of them.
 */

/**
 * What the three rooms share. Every part is required. A lane with no
 * responder answers no v2 handshake, and one with no gate lets every key in.
 */
export type SharedRelayOptions = Required<Pick<
  RelayClientOptions,
  "relayUrl" | "keyPair" | "ownerKey" | "responder" | "legacyTransport" | "peerAuth" | "sessionKeyedPeers"
>>;

/** What differs per lane: the room and the callbacks. */
export type RelayLaneOptions = Omit<RelayClientOptions, keyof SharedRelayOptions | "lane">;

export interface RelayLanes {
  control: RelayLaneOptions;
  bulk: RelayLaneOptions;
  /** Null when this computer has no link room. */
  link: RelayLaneOptions | null;
}

/** The full options for each lane: its own part, the shared part and its lane name. */
export function relayClientOptions(shared: SharedRelayOptions, lanes: RelayLanes): { control: RelayClientOptions; bulk: RelayClientOptions; link: RelayClientOptions | null } {
  const forLane = (lane: RelayLane, own: RelayLaneOptions): RelayClientOptions => ({ ...own, ...shared, lane });
  return {
    control: forLane("control", lanes.control),
    bulk: forLane("bulk", lanes.bulk),
    link: lanes.link ? forLane("link", lanes.link) : null,
  };
}
