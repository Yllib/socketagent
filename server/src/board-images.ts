import * as os from "os";
import { hasInlineImages, snapshotInlineImages } from "./inline-image-markdown";
import { loadOrCreateKeyPair, toBase64 } from "./relay-crypto";
import { socketAgentDataPath } from "./socket-agent-paths";

let self: { publicKey: string; name: string } | undefined;

/**
 * This computer as board image links name it: its relay public key, which
 * every device paired with it stores as the server's key, and its hostname
 * for the placeholder a device without a connection to it shows.
 */
function thisComputer(): { publicKey: string; name: string } {
  self ??= {
    publicKey: toBase64(loadOrCreateKeyPair(socketAgentDataPath("relay-keys.json")).publicKey),
    name: os.hostname(),
  };
  return self;
}

const IMAGE_LINK = /socketagent:\/\/image\?[^\s)"'\]<>]+/g;

/**
 * Saves the images a card's detail shows (Markdown images and
 * socketagent-compare blocks) to this computer's image store, and tags each
 * link with this computer so any device loads it over its connection here.
 * The board, and so the relay, holds only the link. A link that already
 * names a computer keeps it. failed counts images this call could not save;
 * placeholders already in [detail] from an earlier write don't count.
 */
export async function attachBoardImages(detail: string, sessionId: string): Promise<{ detail: string; failed: number }> {
  if (!hasInlineImages(detail)) return { detail, failed: 0 };
  const snapped = await snapshotInlineImages(detail, sessionId);
  const { publicKey, name } = thisComputer();
  const unavailable = (text: string) => text.split("name=unavailable.png").length - 1;
  const failed = unavailable(snapped) - unavailable(detail);
  const tagged = snapped.replace(IMAGE_LINK, (link) => {
    let url: URL;
    try {
      url = new URL(link.replace(/&amp;/g, "&"));
    } catch {
      return link;
    }
    if (!url.searchParams.has("id") || url.searchParams.has("computer")) return link;
    url.searchParams.set("computer", publicKey);
    url.searchParams.set("computerName", name);
    return url.toString();
  });
  return { detail: tagged, failed };
}
