// @illuminate/core: the map format and the checker that decides which of a map's claims the code backs.
export {
  Absence,
  Area,
  CodeMap,
  Edge,
  EdgeKind,
  Evidence,
  GitRef,
  Node,
  NodeKind,
  Page,
  PageRegion,
  Slot,
  Screen,
  ScreenElement,
  TourStop,
  Proposal,
  isAddition,
  isSafeRelativePath,
  parseMap,
  type MapAbsence,
  type MapEdge,
  type MapNode,
  type ParseResult,
  QUESTION_MAX,
} from './format';
export { addToMap, freshId, mapIds, patchMap, removeAbsences, removeFromMap, slugify, type MapAdditions, type MapPatch } from './edit';
export { commitInfo, createBaseReader, lineDiff, resolveCommit, type BaseReader } from './base';
export { DEFAULT_LINE_WINDOW, check, checkEvidence, settledProposals, sidesOf, type AbsenceCheck, type ChangeCheck, type SinceCheck, type CheckOptions, type CheckReport, type ClaimCheck, type EvidenceCheck, type Proof, type ProposalCheck, type Status, type TourCheck } from './check';
export { checkNotes, codeForNotes, codeOf, type CodeBlock, type CodeNote, type CodeView } from './code';
export { MAX_FILE_BYTES, SECRET_GLOBS, createRepoReader, isSecretPath, type ReadResult, type RepoReader } from './repo';
export {
  Capture,
  IMAGE_TYPES,
  SCREENS_DIR,
  capturePaths,
  checkPage,
  checkScreen,
  findOnCapture,
  readCapture,
  repoImage,
  type CapturedElement,
  type PageCheck,
  type PageShow,
  type ScreenBox,
  type ScreenCheck,
  type ScreenShow,
} from './screens';
