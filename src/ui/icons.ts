// The shared icon set from design/icons (SF Symbols names), inlined as text
// by esbuild so they inherit currentColor.

import arrowUpRight from "../../design/icons/arrow.up.right.svg";
import arrowDownCircle from "../../design/icons/arrow.down.circle.svg";
import chevronDown from "../../design/icons/chevron.down.svg";
import checkmark from "../../design/icons/checkmark.svg";
import docOnDoc from "../../design/icons/doc.on.doc.svg";
import exclamation from "../../design/icons/exclamationmark.triangle.svg";
import folder from "../../design/icons/folder.svg";
import clock from "../../design/icons/clock.svg";
import gearshape from "../../design/icons/gearshape.svg";
import trash from "../../design/icons/trash.svg";
import film from "../../design/icons/film.svg";
import lock from "../../design/icons/lock.svg";
import rectangleInsetTopright from "../../design/icons/rectangle.inset.topright.filled.svg";
import recordCircle from "../../design/icons/record.circle.svg";
import sidebarRight from "../../design/icons/sidebar.right.svg";
import squareAndArrowUp from "../../design/icons/square.and.arrow.up.svg";
import star from "../../design/icons/star.svg";
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
  folder,
  gear: gearshape,
  clock,
  sidePanel: sidebarRight,
  popup: rectangleInsetTopright,
  trash,
  external: arrowUpRight,
  star,
  share: squareAndArrowUp,
  waveform,
};
