/**
 * Viber REST Bot API callback (subset), as documented at https://developers.viber.com/docs/api/rest-bot-api/
 * Callbacks are 1:1 conversations between a user and the bot; the API has no group-chat callbacks.
 */
export interface ViberCallback {
  event?: string;
  timestamp?: number;
  /** 64-bit integer: read from the raw body (JSON numbers lose precision above 2^53). */
  message_token?: number;
  sender?: { id?: string; name?: string };
  message?: {
    type?: string;
    text?: string;
    media?: string;
    file_name?: string;
    file_size?: number;
    duration?: number;
    location?: { lat?: number; lon?: number };
  };
}

export interface ViberAccountInfo {
  status?: number;
  status_message?: string;
  webhook?: string;
}
