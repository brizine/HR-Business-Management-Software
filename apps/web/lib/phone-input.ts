import type { FormEvent } from "react";
import { formatPhoneTyping } from "@crewdesk/shared";

/**
 * Props for a phone number box: formats US numbers as (555) 555-5555 while typing.
 * Works on uncontrolled inputs (defaultValue + FormData); for controlled ones, run
 * formatPhoneTyping in onChange instead.
 */
export const phoneInput = {
  type: "tel",
  inputMode: "tel" as const,
  placeholder: "(555) 555-5555",
  maxLength: 40,
  onInput: (e: FormEvent<HTMLInputElement>) => {
    const el = e.currentTarget;
    const next = formatPhoneTyping(el.value);
    if (next !== el.value) el.value = next;
  },
};
