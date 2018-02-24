import * as prism from "prismjs";
import * as vscode from "vscode";
import FoundBracket from "./foundBracket";
import Settings from "./settings";
import TextLine from "./textLine";

export default class DocumentDecoration {
    private prismLanguages = require("prism-languages");
    private updateDecorationTimeout: NodeJS.Timer | null;

    // This program caches lines, and will only analyze linenumbers including or above a modified line
    private lineToUpdateWhenTimeoutEnds = 0;
    private lines: TextLine[] = [];
    private readonly document: vscode.TextDocument;
    private readonly settings: Settings;

    constructor(document: vscode.TextDocument, settings: Settings) {
        this.settings = settings;
        this.document = document;
    }

    public dispose() {
        this.settings.dispose();
    }

    public onDidChangeTextDocument(contentChanges: vscode.TextDocumentContentChangeEvent[]) {
        this.updateLowestLineNumber(contentChanges);
        this.triggerUpdateDecorations();
    }

    // Lines are stored in an array, if line is requested outside of array bounds
    // add emptys lines until array is correctly sized
    public getLine(index: number, document: vscode.TextDocument): TextLine {
        if (index < this.lines.length) {
            return this.lines[index];
        }
        else {
            if (this.lines.length === 0) {
                this.lines.push(new TextLine(document.lineAt(0).text, this.settings, 0));
            }

            for (let i = this.lines.length; i <= index; i++) {
                const previousLine = this.lines[this.lines.length - 1];
                const newLine =
                    new TextLine(document.lineAt(i).text, this.settings, i, previousLine.copyMultilineContext());

                this.lines.push(newLine);
            }

            const lineToReturn = this.lines[this.lines.length - 1];
            return lineToReturn;
        }
    }

    public triggerUpdateDecorations() {
        if (this.settings.isDisposed) {
            return;
        }

        if (this.settings.timeOutLength > 0) {

            if (this.updateDecorationTimeout) {
                clearTimeout(this.updateDecorationTimeout);
            }

            this.updateDecorationTimeout = setTimeout(() => {
                this.updateDecorations();
            }, this.settings.timeOutLength);
        }
        else {
            this.updateDecorations();
        }
    }

    private updateLowestLineNumber(contentChanges: vscode.TextDocumentContentChangeEvent[]) {
        for (const contentChange of contentChanges) {
            this.lineToUpdateWhenTimeoutEnds =
                Math.min(this.lineToUpdateWhenTimeoutEnds, contentChange.range.start.line);
        }
    }

    private updateDecorations() {
        // One document may be shared by multiple editors (side by side view)
        const editors: vscode.TextEditor[] =
            vscode.window.visibleTextEditors.filter((e) => this.document === e.document);

        if (editors.length === 0) {
            console.warn("No editors associated with document: " + this.document.fileName);
            return;
        }

        const lineNumber = this.lineToUpdateWhenTimeoutEnds;
        const amountToRemove = this.lines.length - lineNumber;

        // Remove cached lines that need to be updated
        this.lines.splice(lineNumber, amountToRemove);

        const languages = Object.keys(this.prismLanguages);

        const text = this.document.getText();
        let tokenized: Array<string | prism.Token>;
        try {
            tokenized = prism.tokenize(text, prism.languages[this.document.languageId]);
            if (!tokenized) {
                return;
            }
        }
        catch (err) {
            console.warn(err);
            return;
        }

        const positions: FoundBracket[] = [];
        this.parseTokenOrStringArray(tokenized, 0, 0, positions);

        positions.forEach((element) => {
            const currentLine = this.getLine(element.range.start.line, this.document);
            currentLine.addBracket(element);
        });

        this.colorDecorations(editors);
    }

    private parseTokenOrStringArray(
        tokenized: Array<string | prism.Token>,
        lineIndex: number,
        charIndex: number,
        positions: FoundBracket[]) {
        tokenized.forEach((token) => {
            if (token instanceof prism.Token) {
                const result = this.parseToken(token, lineIndex, charIndex, positions);
                charIndex = result.charIndex;
                lineIndex = result.lineIndex;
            }
            else {
                const result = this.parseString(token, lineIndex, charIndex);
                charIndex = result.charIndex;
                lineIndex = result.lineIndex;
            }
        });
        return { lineIndex, charIndex };
    }

    private parseString(content: string, lineIndex: number, charIndex: number) {
        const split = content.split("\n");
        if (split.length > 1) {
            lineIndex += split.length - 1;
            charIndex = split[split.length - 1].length;
        }
        else {
            charIndex += content.length;
        }
        return { lineIndex, charIndex };
    }

    private parseToken(
        token: prism.Token,
        lineIndex: number,
        charIndex: number,
        positions: FoundBracket[]): { lineIndex: number, charIndex: number } {
        if (typeof token.content === "string") {
            const content = token.content;
            if (token.type === "punctuation") {
                if (lineIndex >= this.lineToUpdateWhenTimeoutEnds &&
                    content.match(this.settings.regexPattern)) {
                    const startPos = new vscode.Position(lineIndex, charIndex);
                    const endPos = startPos.translate(0, content.length);
                    positions.push(new FoundBracket(new vscode.Range(startPos, endPos), content));
                }
            }
            return this.parseString(content, lineIndex, charIndex);
        }
        else if (Array.isArray(token.content)) {
            return this.parseTokenOrStringArray(token.content, lineIndex, charIndex, positions);
        }
        else {
            // Token
            if (Array.isArray(token.content.content)) {
                return this.parseTokenOrStringArray(token.content.content, lineIndex, charIndex, positions);
            }
            else {
                return this.parseToken(token.content, lineIndex, charIndex, positions);
            }
        }
    }

    private colorDecorations(editors: vscode.TextEditor[]) {
        const colorMap = new Map<string, vscode.Range[]>();

        // Reduce all the colors/ranges of the lines into a singular map
        for (const line of this.lines) {
            {
                for (const [color, ranges] of line.colorRanges) {
                    const existingRanges = colorMap.get(color);

                    if (existingRanges !== undefined) {
                        existingRanges.push(...ranges);
                    }
                    else {
                        // Slice because we will be adding values to this array in the future,
                        // but don't want to modify the original array which is stored per line
                        colorMap.set(color, ranges.slice());
                    }
                }
            }
        }

        for (const [color, decoration] of this.settings.bracketDecorations) {
            if (color === "") {
                continue;
            }
            const ranges = colorMap.get(color);
            editors.forEach((editor) => {
                if (ranges !== undefined) {
                    editor.setDecorations(decoration, ranges);
                }
                else {
                    // We must set non-used colors to an empty array
                    // or previous decorations will not be invalidated
                    editor.setDecorations(decoration, []);
                }
            });
        }

        this.lineToUpdateWhenTimeoutEnds = Infinity;
    }
}
