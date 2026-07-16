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

declare module "node-pty" {
	export interface IDisposable {
		dispose(): void;
	}

	export interface IPty {
		onData(callback: (data: string) => void): IDisposable;
		onExit(callback: (event: { exitCode: number; signal?: number | string }) => void): IDisposable;
		write(data: string): void;
		kill(signal?: string): void;
	}

	export function spawn(
		file: string,
		args: string[],
		options?: {
			cwd?: string;
			env?: NodeJS.ProcessEnv;
			name?: string;
			cols?: number;
			rows?: number;
		},
	): IPty;
}
