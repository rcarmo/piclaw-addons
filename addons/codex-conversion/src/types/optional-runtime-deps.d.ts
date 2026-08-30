declare module "web-tree-sitter" {
	export class Language {
		static load(path: string): Promise<Language>;
	}

	export class Parser {
		static init(): Promise<void>;
		setLanguage(language: Language): void;
		parse(input: string): Tree;
	}

	export interface Tree {
		rootNode: Node;
	}

	export interface Node {
		type: string;
		text: string;
		hasError: boolean;
		isNamed: boolean;
		startIndex: number;
		children: Node[];
		namedChildren: Node[];
		namedChild(index: number): Node | null;
	}
}
