import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile } from 'obsidian';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import * as fs from 'fs';

interface TellaSettings {
	geminiApiKey: string;
	transcriptionPrompt: string;
	modelName: string;
}

const DEFAULT_SETTINGS: TellaSettings = {
	geminiApiKey: '',
	transcriptionPrompt: 'Transcribe the following audio, ensuring to capture every word accurately. Ignore any background noise or non-verbal sounds. The output should be a clean, readable text.',
	modelName: 'gemini-2.5-flash',
};

class GeminiService {
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	private getGenAI(): GoogleGenerativeAI | null {
		if (!this.apiKey) {
			return null;
		}
		return new GoogleGenerativeAI(this.apiKey);
	}

	async validateApi(modelName: string): Promise<boolean> {
		const genAI = this.getGenAI();
		if (!genAI) {
			new Notice('Gemini API key is not set.');
			return false;
		}
		try {
			const model = genAI.getGenerativeModel({ model: modelName });
			await model.generateContent("ping");
			return true;
		} catch (error) {
			console.error(`Gemini API validation failed for model ${modelName}:`, error);
			return false;
		}
	}

	private generativePart(path: string, mimeType: string) {
		return {
			inlineData: {
				data: Buffer.from(fs.readFileSync(path)).toString("base64"),
				mimeType
			},
		};
	}

	async transcribeAudio(audioPath: string, prompt: string, modelName: string): Promise<string> {
		const genAI = this.getGenAI();
		if (!genAI) {
			throw new Error("Gemini API key is not configured.");
		}
		const model = genAI.getGenerativeModel({ model: modelName });

		const audioMimeType = this.getMimeType(audioPath);
		if (!audioMimeType) {
			throw new Error(`Unsupported audio format for file: ${audioPath}`);
		}

		const audioPart = this.generativePart(audioPath, audioMimeType);

		const result = await model.generateContent([prompt, audioPart]);
		return result.response.text();
	}

	private getMimeType(filePath: string): string | null {
		const extension = filePath.split('.').pop()?.toLowerCase();
		switch (extension) {
			case 'mp3': return 'audio/mp3';
			case 'wav': return 'audio/wav';
			case 'm4a': return 'audio/m4a';
			case 'flac': return 'audio/flac';
			case 'ogg': return 'audio/ogg';
			case 'aac': return 'audio/aac';
			case 'webm': return 'audio/webm';
			default: return null;
		}
	}
}

export default class Tella extends Plugin {
	settings: TellaSettings;
	geminiService: GeminiService;

	async onload() {
		await this.loadSettings();
		this.geminiService = new GeminiService(this.settings.geminiApiKey);

		this.addCommand({
			id: 'transcribe-audio-in-note',
			name: 'Transcribe audio in note',
			callback: () => this.transcribeAudioInNote()
		});

		this.addSettingTab(new TellaSettingTab(this.app, this));
	}

	onunload() {}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
		// Re-initialize GeminiService with the new API key
		this.geminiService = new GeminiService(this.settings.geminiApiKey);
	}

	async transcribeAudioInNote() {
		if (!this.settings.geminiApiKey) {
			new Notice('Gemini API key is not set. Please configure it in the settings.');
			return;
		}

		const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
		if (!activeView) {
			new Notice('No active note to transcribe.');
			return;
		}

		const editor = activeView.editor;
		const content = editor.getValue();
		const audioFileRegex = /!\[\[(.*?\.(mp3|wav|m4a|flac|ogg|aac|webm))\]\]/g;
		const audioFiles = [...content.matchAll(audioFileRegex)];

		if (audioFiles.length === 0) {
			new Notice('未找到音频');
			return;
		}

		new Notice(`Found ${audioFiles.length} audio file(s). Starting transcription...`);

		const jobs: any[] = [];
		// Step 1: Sequentially create placeholders and collect jobs to avoid race conditions on editor positions.
		for (const match of audioFiles.reverse()) {
			const originalLink = match[0];
			const fileName = match[1];
			const matchIndex = match.index as number;

			const startPos = editor.offsetToPos(matchIndex);
			const endPos = editor.offsetToPos(matchIndex + originalLink.length);

			const placeholderBlock = `> [!tip] Audio Note\n> ⏳ Transcribing ${fileName}...\n> ${originalLink}\n`;
			editor.replaceRange(placeholderBlock, startPos, endPos);

			if (!activeView.file) {
				const errorBlock = `> [!warning] Transcription Failed\n> Active note is not a file.\n> ${originalLink}\n`;
				const newEndPos = editor.offsetToPos(editor.posToOffset(startPos) + placeholderBlock.length);
				editor.replaceRange(errorBlock, startPos, newEndPos);
				continue;
			}

			const file = this.app.metadataCache.getFirstLinkpathDest(fileName, activeView.file.path);
			if (file instanceof TFile) {
				const filePath = (this.app.vault.adapter as any).getFullPath(file.path);
				jobs.push({ filePath, startPos, placeholderBlock, originalLink, fileName });
			} else {
				const errorBlock = `> [!warning] Transcription Failed\n> Could not find file: ${fileName}\n> ${originalLink}\n`;
				const newEndPos = editor.offsetToPos(editor.posToOffset(startPos) + placeholderBlock.length);
				editor.replaceRange(errorBlock, startPos, newEndPos);
				new Notice(`Could not find the file: ${fileName}`);
			}
		}

		// Step 2: Concurrently execute transcription jobs and update UI as they complete.
		const promises = jobs.map(async (job) => {
			const updateCallout = (blockToInsert: string) => {
				const currentContent = editor.getValue();
				const placeholderIndex = currentContent.indexOf(job.placeholderBlock);
				if (placeholderIndex !== -1) {
					const startPos = editor.offsetToPos(placeholderIndex);
					const endPos = editor.offsetToPos(placeholderIndex + job.placeholderBlock.length);
					editor.replaceRange(blockToInsert, startPos, endPos);
				} else {
					console.error(`Could not find placeholder for ${job.fileName} to update. It might have been modified or removed.`);
					new Notice(`Could not update transcription for ${job.fileName}.`);
				}
			};

			try {
				const transcriptionText = await this.geminiService.transcribeAudio(job.filePath, this.settings.transcriptionPrompt, this.settings.modelName);
				const formattedTranscription = transcriptionText.replace(/\n/g, '\n> ');
				const finalBlock = `> [!tip] Audio Note\n> ${formattedTranscription}\n> ${job.originalLink}\n`;
				updateCallout(finalBlock);
			} catch (error) {
				console.error(`Error transcribing ${job.fileName}:`, error);
				const errorBlock = `> [!warning] Transcription Failed\n> Check console for details.\n> ${job.originalLink}\n`;
				updateCallout(errorBlock);
			}
		});

		await Promise.all(promises);
		new Notice('All transcriptions complete!');
	}
}

class TellaSettingTab extends PluginSettingTab {
	plugin: Tella;

	constructor(app: App, plugin: Tella) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		// API Key Setting
		const apiKeySetting = new Setting(containerEl)
			.setName('Gemini API Key')
			.setDesc('Your API key for Google Gemini.');
		
		apiKeySetting.controlEl.style.width = '50%';
		apiKeySetting.addText(text => {
			text
				.setPlaceholder('Enter your API key')
				.setValue(this.plugin.settings.geminiApiKey)
				.onChange(async (value) => {
					this.plugin.settings.geminiApiKey = value;
					await this.plugin.saveSettings();
				});
		})
		.addButton(button => {
			button
				.setButtonText('Validate')
				.onClick(async () => {
					new Notice('Validating API key and model...');
					const isValid = await this.plugin.geminiService.validateApi(this.plugin.settings.modelName);
					if (isValid) {
						new Notice('API key and model are valid!');
					} else {
						new Notice('API validation failed. Check key, model, and console for details.');
					}
				});
		});

		// Model Name Setting
		const modelNameSetting = new Setting(containerEl)
			.setName('Model Name')
			.setDesc('The Gemini model to use for transcription.');
		
		modelNameSetting.controlEl.style.width = '50%';
		modelNameSetting.addText(text => {
			text
				.setPlaceholder('e.g., gemini-2.5-flash')
				.setValue(this.plugin.settings.modelName)
				.onChange(async (value) => {
					this.plugin.settings.modelName = value;
					await this.plugin.saveSettings();
				});
		});

		// Prompt Setting
		const promptSetting = new Setting(containerEl)
			.setName('Transcription Prompt')
			.setDesc('The prompt to use when transcribing audio.');

		promptSetting.controlEl.style.width = '50%';
		promptSetting.addTextArea(text => {
			text
				.setPlaceholder('Enter your prompt')
				.setValue(this.plugin.settings.transcriptionPrompt)
				.onChange(async (value) => {
					this.plugin.settings.transcriptionPrompt = value;
					await this.plugin.saveSettings();
				});
			text.inputEl.style.height = '100px';
		});
	}
}

