export interface MarkdownPoint { offset?: number }
export interface MarkdownNode {
  type: string;
  position?: { start: MarkdownPoint; end: MarkdownPoint };
  children?: MarkdownNode[];
}
export function fromMarkdown(value: string): MarkdownNode;
