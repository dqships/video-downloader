// The shared icon set from design/icons (SF Symbols names), inlined as text
// by esbuild so they inherit currentColor.

import arrowDownCircle from "../../design/icons/arrow.down.circle.svg";
import chevronDown from "../../design/icons/chevron.down.svg";
import checkmark from "../../design/icons/checkmark.svg";
import docOnDoc from "../../design/icons/doc.on.doc.svg";
import exclamation from "../../design/icons/exclamationmark.triangle.svg";
import film from "../../design/icons/film.svg";
import lock from "../../design/icons/lock.svg";
import recordCircle from "../../design/icons/record.circle.svg";
import stopFill from "../../design/icons/stop.fill.svg";
import waveform from "../../design/icons/waveform.svg";
import xmark from "../../design/icons/xmark.svg";

export const icons = {
  download: arrowDownCircle,
  copy: docOnDoc,
  check: checkmark,
  chevronDown,
  close: xmark,
  lock,
  record: recordCircle,
  stop: stopFill,
  warning: exclamation,
  film,
  waveform,
};
