export interface FormNameElement {
  tag: string;
  attributes: { name: string; value: unknown; form: 'static' | 'property' | 'attribute' | 'interpolated' }[];
  readable: boolean;
  parent?: number;
  branches?: [group: number, arm: number][];
}
export function namedFormFields(elements: FormNameElement[]): Set<number>;
