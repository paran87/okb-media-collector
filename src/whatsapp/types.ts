/**
 * WhatsApp Cloud API webhook payload (subset used here), as documented by Meta:
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/groups/groups-messaging/
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media/
 * Every field is optional here because the collector validates the payload instead of trusting its shape.
 */

export interface WaMediaObject {
  id?: string;
  mime_type?: string;
  sha256?: string;
  caption?: string;
  filename?: string;
  voice?: boolean;
  animated?: boolean;
}

export interface WaMessage {
  from?: string;
  id?: string;
  timestamp?: string;
  type?: string;
  /** Present on messages received in a group (Groups API). */
  group_id?: string;
  text?: { body?: string };
  image?: WaMediaObject;
  video?: WaMediaObject;
  document?: WaMediaObject;
  audio?: WaMediaObject;
  sticker?: WaMediaObject;
  location?: { latitude?: number; longitude?: number; name?: string; address?: string };
  errors?: { code?: number; title?: string; message?: string }[];
}

export interface WaChangeValue {
  messaging_product?: string;
  metadata?: { display_phone_number?: string; phone_number_id?: string };
  contacts?: { profile?: { name?: string }; wa_id?: string }[];
  messages?: WaMessage[];
  statuses?: unknown[];
}

export interface WaWebhookBody {
  object?: string;
  entry?: { id?: string; changes?: { field?: string; value?: WaChangeValue }[] }[];
}

/** GET /{version}/{media-id} response. */
export interface WaMediaUrlResponse {
  url?: string;
  mime_type?: string;
  sha256?: string;
  file_size?: number | string;
  id?: string;
}
