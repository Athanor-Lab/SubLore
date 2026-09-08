import { useLayoutEffect, useRef, useState } from "react";

import { useLayer } from "../hooks/useLayers";
import { en } from "../i18n/en";

type OpenEncodingProps = {
  onChoose: (label: string) => void;
  onClose: () => void;
};

/**
 * The charset dialog Open with encoding raises after the file picker (interface-spec 9.8). The user
 * names the encoding their file is in and the backend decodes it to UTF-8; the list is the WHATWG
 * set `encoding_rs` supports, grouped by region for finding one. A charset name is a technical
 * identifier, the same as a format name, so it is not translated; the dialog's own words are.
 *
 * The `value` of each entry is the `encoding_rs` label the backend reads, never a display string.
 */
const ENCODINGS: readonly { label: string; name: string }[] = [
  { label: "utf-8", name: "UTF-8 (Unicode)" },
  { label: "utf-16le", name: "UTF-16 little-endian (Unicode)" },
  { label: "utf-16be", name: "UTF-16 big-endian (Unicode)" },
  { label: "windows-1252", name: "Windows-1252 (Western European)" },
  { label: "iso-8859-15", name: "ISO-8859-15 (Western European)" },
  { label: "macintosh", name: "Macintosh (Western European)" },
  { label: "windows-1250", name: "Windows-1250 (Central European)" },
  { label: "iso-8859-2", name: "ISO-8859-2 (Central European)" },
  { label: "windows-1251", name: "Windows-1251 (Cyrillic)" },
  { label: "koi8-r", name: "KOI8-R (Cyrillic)" },
  { label: "koi8-u", name: "KOI8-U (Cyrillic)" },
  { label: "iso-8859-5", name: "ISO-8859-5 (Cyrillic)" },
  { label: "ibm866", name: "IBM866 (Cyrillic)" },
  { label: "windows-1253", name: "Windows-1253 (Greek)" },
  { label: "iso-8859-7", name: "ISO-8859-7 (Greek)" },
  { label: "windows-1254", name: "Windows-1254 (Turkish)" },
  { label: "windows-1255", name: "Windows-1255 (Hebrew)" },
  { label: "windows-1256", name: "Windows-1256 (Arabic)" },
  { label: "windows-1257", name: "Windows-1257 (Baltic)" },
  { label: "iso-8859-13", name: "ISO-8859-13 (Baltic)" },
  { label: "windows-1258", name: "Windows-1258 (Vietnamese)" },
  { label: "windows-874", name: "Windows-874 (Thai)" },
  { label: "shift_jis", name: "Shift_JIS (Japanese)" },
  { label: "euc-jp", name: "EUC-JP (Japanese)" },
  { label: "iso-2022-jp", name: "ISO-2022-JP (Japanese)" },
  { label: "gbk", name: "GBK (Simplified Chinese)" },
  { label: "gb18030", name: "GB18030 (Simplified Chinese)" },
  { label: "big5", name: "Big5 (Traditional Chinese)" },
  { label: "euc-kr", name: "EUC-KR (Korean)" },
];

export default function OpenEncoding({ onChoose, onClose }: OpenEncodingProps) {
  const selectRef = useRef<HTMLSelectElement>(null);
  const [label, setLabel] = useState(ENCODINGS[0].label);
  // Mounted only while the panel is open, so the video surface hides for exactly that long (T8).
  useLayer(true);

  useLayoutEffect(() => {
    selectRef.current?.focus();
  }, []);

  const words = en.openEncoding;

  return (
    <div
      className="openencoding"
      role="dialog"
      aria-modal="true"
      aria-label={words.title}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="openencoding__panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <label className="openencoding__field">
          <span className="openencoding__label">{words.prompt}</span>
          <select
            className="openencoding__select"
            ref={selectRef}
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onChoose(label);
              }
            }}
          >
            {ENCODINGS.map((encoding) => (
              <option key={encoding.label} value={encoding.label}>
                {encoding.name}
              </option>
            ))}
          </select>
        </label>
        <div className="openencoding__buttons">
          <button type="button" className="openencoding__open" onClick={() => onChoose(label)}>
            {words.open}
          </button>
          <button type="button" className="openencoding__cancel" onClick={onClose}>
            {words.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}
