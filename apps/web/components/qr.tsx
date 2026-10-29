"use client";
import QRCode from "qrcode";
import { useEffect, useState } from "react";

/**
 * The address a label points to. Phones' built-in cameras open it in the
 * browser; the Crewdesk app's scanner reads the code from it. Set
 * NEXT_PUBLIC_WEB_URL if staff reach the site at a different address than
 * the one you print labels from.
 */
export function assetQrUrl(code: string) {
  const base = process.env.NEXT_PUBLIC_WEB_URL ?? (typeof window !== "undefined" ? window.location.origin : "");
  return `${base.replace(/\/$/, "")}/q/${code}`;
}

export async function qrSvg(value: string) {
  return QRCode.toString(value, { type: "svg", margin: 1, errorCorrectionLevel: "M" });
}

export function QrCode({ value, size = 160 }: { value: string; size?: number }) {
  const [svg, setSvg] = useState("");
  useEffect(() => {
    qrSvg(value).then(setSvg);
  }, [value]);
  return <div className="qr" style={{ width: size, height: size }} dangerouslySetInnerHTML={{ __html: svg }} />;
}

/** A printable label: QR, asset name and its code (for typing in if the QR is damaged). */
export function AssetLabel({ asset, company, size = "large" }: { asset: { name: string; qrCode: string; licensePlate?: string | null; serialNumber?: string | null }; company: string; size?: "small" | "large" }) {
  const id = asset.licensePlate || asset.serialNumber;
  return (
    <div className={`label label-${size}`}>
      <QrCode value={assetQrUrl(asset.qrCode)} size={size === "large" ? 130 : 84} />
      <div className="label-text">
        <div className="label-name">{asset.name}</div>
        {id && <div className="label-sub">{id}</div>}
        <div className="label-sub">Scan to inspect or report an issue</div>
        <div className="label-code">{company} · {asset.qrCode}</div>
      </div>
    </div>
  );
}
