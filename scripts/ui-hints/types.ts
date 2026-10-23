import type ts from 'typescript';
import type { AST } from '@angular/compiler';

export const RULE_CODES = ['H1a', 'H1b', 'H2a', 'H2b', 'H2c', 'H3', 'H4', 'H5', 'H6', 'H10', 'H11'] as const;
export const REPORT_ONLY = ['H1c', 'H7', 'H8'] as const;
export const DORMANT: readonly string[] = []; // H8 is now report-only: glossary shipped.
export const HOVER_BINDINGS = ['title', 'appTooltip', 'appIconButton', 'appTooltipDisabledReason', 'appIconButtonDisabledReason'] as const;
export const TOOLTIP_PROVIDERS = ['appTooltip', 'appTooltipTpl', 'appIconButton', 'appTooltipDisabledReason'] as const;
export const NAME_PROVIDERS = ['aria-label', 'aria-labelledby', 'appIconButton'] as const;
export const EXEMPT_REASONS = ['backdrop', 'decorative', 'local-key'] as const;
export const CONTROL_TAGS = ['button', 'summary'] as const;
export const FIELD_TAGS = ['input', 'select', 'textarea'] as const;
export const INTERACTIVE_ROLES = ['button', 'link', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'checkbox', 'radio', 'switch', 'option', 'combobox', 'slider', 'spinbutton'] as const;
export const TITLE_EXCEPTIONS = ['iframe', 'frame', 'embed', 'object', 'math', 'title'] as const;
export const SHORTCUT_SOURCE = '[⌘⌥⇧⌃]|(?:Cmd|Ctrl|Alt|Shift)\\+|\\((?:Esc|Enter)\\)|\\+Enter|-(?:click)';
export const SHORTCUT_PATTERN = new RegExp(SHORTCUT_SOURCE, 'i');
// Literal fragments never join across a dynamic hole or different hover branches.
export const TEXT_GAP = 'harnessuihintsdynamicgap';
export const WORD = /\p{L}{2,}/u;
export const normalizePath = (path: string): string => path.replace(/\\/g, '/');
export type RuleCode = typeof RULE_CODES[number] | typeof REPORT_ONLY[number] | 'H9' | 'H12';
export interface Violation { code: RuleCode; ownerFile: string; file: string; line: number; message: string }
export interface TemplateSource { ownerFile: string; file: string; text: string; firstLine: number; imports: string[]; sourceFile: ts.SourceFile; component: ts.ClassDeclaration }
export interface Collection { templates: TemplateSource[]; sourceFiles: ts.SourceFile[]; errors: Violation[]; componentCount: number }
export interface HoverText { channel: string; fragments: string[]; dynamic: boolean; unreadable: boolean }
export interface AttributeFact { name: string; text?: string; expression?: AST; source?: string; form: 'static' | 'property' | 'attribute' | 'interpolated' }
export interface ElementFact {
  ownerFile: string; file: string; line: number; tag: string; attributes: AttributeFact[];
  componentHost: boolean; control: boolean; field: boolean; role?: string; title?: AttributeFact;
  tooltip: boolean; inert: string[]; hover: HoverText[]; name: boolean; dataName: boolean;
  visible: string[]; dataText: boolean; opaque: boolean; iconOnly: boolean; focusable: boolean;
  hidden: boolean; marker?: string; firstClass: string; nested: boolean; click?: string; disabled?: string;
}
export interface Analysis { collection: Collection; facts: ElementFact[]; violations: Violation[]; outside: Violation[]; streams: Record<string, string[]>; copyKeys: Record<string, string>; counts: Record<string, number> }
