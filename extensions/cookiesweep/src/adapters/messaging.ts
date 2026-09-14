import { errorMessage } from "@browserforge/shared";
import { browser } from "wxt/browser";
import type { Message, MessageResponse } from "../lib/messages.js";

/** Sends a request to the background; transport failures come back as `{ ok: false }`. */
export async function sendMessage(message: Message): Promise<MessageResponse> {
  try {
    const response = (await browser.runtime.sendMessage(message)) as MessageResponse | undefined;
    if (!response) return { ok: false, error: "No response from the background service." };
    return response;
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
