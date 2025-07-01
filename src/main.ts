import { App, MarkdownView, Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from 'obsidian';
import { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } from '@google/generative-ai';
import * as fs from 'fs';

interface TellaSettings {
	provider: 'gemini' | 'openrouter';
	geminiApiKey: string;
	geminiModelName: string;
	openrouterApiKey: string;
	openrouterModelName: string;
	transcriptionPrompt: string;
}

const DEFAULT_SETTINGS: TellaSettings = {
	provider: 'gemini',
	geminiApiKey: '',
	geminiModelName: 'gemini-1.5-flash',
	openrouterApiKey: '',
	openrouterModelName: 'openai/whisper-large-v3',
	transcriptionPrompt: 'Transcribe the following audio, ensuring to capture every word accurately. Ignore any background noise or non-verbal sounds. The output should be a clean, readable text.',
};

class OpenRouterService {
	private apiKey: string;

	constructor(apiKey: string) {
		this.apiKey = apiKey;
	}

	async validateApi(): Promise<boolean> {
		if (!this.apiKey) {
			new Notice('OpenRouter API key is not set.');
			return false;
		}
		try {
			const response = await requestUrl({
				url: 'https://openrouter.ai/api/v1/auth/key',
				method: 'GET',
				headers: {
					'Authorization': `Bearer ${this.apiKey}`,
				},
			});

			if (response.status === 200) {
				// The response for a valid key is { "data": { ... } } or similar.
				if (response.json && response.json.data) {
					return true;
				} else {
					new Notice('API key is valid but response format is unexpected.');
					return false;
				}
			} else {
				console.error('OpenRouter API validation failed:', response);
				new Notice(`OpenRouter validation failed: Status ${response.status}. Check console for details.`);
				return false;
			}
		} catch (error) {
			console.error('OpenRouter API validation request failed:', error);
			let errorMessage = error.message || 'Unknown error';
			if (error.headers) {
				console.error('Response Headers:', error.headers);
			}
			if (error.body) {
				try {
					const errorBody = JSON.parse(error.body);
					errorMessage = errorBody.error?.message || JSON.stringify(errorBody);
				} catch (e) {
					errorMessage = error.body;
				}
			}
			new Notice(`OpenRouter validation failed: ${errorMessage}. Check console for details.`);
			return false;
		}
	}

	async transcribeAudio(audioPath: string, modelName: string): Promise<string> {
		if (!this.apiKey) {
			throw new Error("OpenRouter API key is not configured.");
		}

		const audioBuffer = fs.readFileSync(audioPath);
		const fileName = audioPath.split(/[\\/]/).pop() || 'audio.dat';
		const boundary = '----ObsidianFormBoundary' + Date.now().toString(16);
		const contentType = `multipart/form-data; boundary=${boundary}`;

		let data = '';
		data += `--${boundary}\r\n`;
		data += `Content-Disposition: form-data; name="model"\r\n\r\n`;
		data += `${modelName}\r\n`;
		data += `--${boundary}\r\n`;
		data += `Content-Disposition: form-data; name="file"; filename="${fileName}"\r\n`;
		data += `Content-Type: "application/octet-stream"\r\n\r\n`;

		const payload = Buffer.concat([
			Buffer.from(data, 'utf-8'),
			audioBuffer,
			Buffer.from(`\r\n--${boundary}--\r\n`, 'utf-8'),
		]);

		try {
			const response = await requestUrl({
				url: 'https://openrouter.ai/api/v1/audio/transcriptions',
				method: 'POST',
				contentType: contentType,
				headers: {
					'Authorization': `Bearer ${this.apiKey}`,
				},
				body: payload,
			});

			if (response.status !== 200) {
				console.error('OpenRouter transcription failed:', response.json);
				throw new Error(`OpenRouter API request failed with status ${response.status}: ${response.json.error?.message || 'Unknown error'}`);
			}

			return response.json.text;
		} catch (error) {
			console.error('Error during OpenRouter transcription:', error);
			let errorMessage = error.message || 'Unknown transcription error';
			if (error.headers) {
				console.error('Response Headers:', error.headers);
			}
			if (error.body) {
				try {
					const errorBody = JSON.parse(error.body);
					errorMessage = errorBody.error?.message || JSON.stringify(errorBody);
				} catch (e) {
					errorMessage = error.body;
				}
			}
			throw new Error(errorMessage);
		}
	}
}

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
	openrouterService: OpenRouterService;

	async onload() {
		await this.loadSettings();

		// Migration: If OpenRouter was selected, revert to Gemini as it's no longer supported for transcription.
		if (this.settings.provider === 'openrouter') {
			this.settings.provider = 'gemini';
			await this.saveSettings();
			console.log('Tella: Migrated provider setting from OpenRouter to Gemini.');
		}
		this.geminiService = new GeminiService(this.settings.geminiApiKey);
		this.openrouterService = new OpenRouterService(this.settings.openrouterApiKey);

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
		// Re-initialize services with new settings
		this.geminiService = new GeminiService(this.settings.geminiApiKey);
		this.openrouterService = new OpenRouterService(this.settings.openrouterApiKey);
	}

	async transcribeAudioInNote() {
		const { provider, geminiApiKey, openrouterApiKey, geminiModelName, openrouterModelName, transcriptionPrompt } = this.settings;

		if (provider === 'gemini' && !geminiApiKey) {
			new Notice('Gemini API key is not set. Please configure it in the settings.');
			return;
		}
		if (provider === 'openrouter' && !openrouterApiKey) {
			new Notice('OpenRouter API key is not set. Please configure it in the settings.');
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

		const modelInUse = provider === 'gemini' ? geminiModelName : openrouterModelName;
		new Notice(`Found ${audioFiles.length} audio file(s). Starting transcription with ${provider} (${modelInUse})...`);

		const jobs: any[] = [];
		// Step 1: Sequentially create placeholders and collect jobs to avoid race conditions on editor positions.
		for (const match of audioFiles.reverse()) {
			const originalLink = match[0];
			const fileName = match[1];
			const matchIndex = match.index as number;

			const startPos = editor.offsetToPos(matchIndex);
			const endPos = editor.offsetToPos(matchIndex + originalLink.length);

			const placeholderBlock = `> [!tip] Audio Note\n> ⏳ Transcribing ${fileName} with ${provider}...\n> ${originalLink}\n`;
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
				let transcriptionText: string;
				if (provider === 'gemini') {
					transcriptionText = await this.geminiService.transcribeAudio(job.filePath, transcriptionPrompt, geminiModelName);
				} else { // openrouter
					transcriptionText = await this.openrouterService.transcribeAudio(job.filePath, openrouterModelName);
				}

				const formattedTranscription = transcriptionText.replace(/\n/g, '\n> ');
				const finalBlock = `> [!tip] Audio Note\n> ${formattedTranscription}\n> ${job.originalLink}\n`;
				updateCallout(finalBlock);
			} catch (error) {
				console.error(`Error transcribing ${job.fileName}:`, error);
				const errorBlock = `> [!warning] Transcription Failed\n> ${error.message}\n> ${job.originalLink}\n`;
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

		containerEl.createEl('h2', { text: 'General Settings' });

		// // Provider Setting
		// new Setting(containerEl)
		// 	.setName('Provider')
		// 	.setDesc('Choose your AI service provider.')
		// 	.addDropdown(dropdown => dropdown
		// 		.addOption('gemini', 'Gemini')
		// 		.addOption('openrouter', 'OpenRouter')
		// 		.setValue(this.plugin.settings.provider)
		// 		.onChange(async (value: 'gemini' | 'openrouter') => {
		// 			this.plugin.settings.provider = value;
		// 			await this.plugin.saveSettings();
		// 			this.display(); // Refresh settings to show/hide relevant fields
		// 		}));

		// Gemini Settings Group
		// if (this.plugin.settings.provider === 'gemini') {
		containerEl.createEl('h3', { text: 'Gemini Settings' });
		// Gemini API Key Setting
		const geminiApiKeySetting = new Setting(containerEl)
			.setName('Gemini API Key')
			.setDesc('Your API key for Google Gemini.');

		const geminiApiKeyInput = geminiApiKeySetting.addText(text => text
			.setPlaceholder('Enter your Gemini API key')
			.setValue(this.plugin.settings.geminiApiKey)
			.onChange(async (value) => {
				this.plugin.settings.geminiApiKey = value;
				await this.plugin.saveSettings();
			}));

		geminiApiKeySetting.addButton(button => button
			.setButtonText('Validate')
			.onClick(async () => {
					new Notice('Validating Gemini API key...');
					const isValid = await this.plugin.geminiService.validateApi(this.plugin.settings.geminiModelName);
					if (isValid) {
						new Notice('Gemini API key is valid!');
					}
					// Error notice is handled within validateApi
				}));

		// Gemini Model Name Setting
		new Setting(containerEl)
			.setName('Gemini Model Name')
			.setDesc('The Gemini model to use for transcription.')
			.addText(text => text
				.setPlaceholder('e.g., gemini-1.5-flash')
				.setValue(this.plugin.settings.geminiModelName)
				.onChange(async (value) => {
					this.plugin.settings.geminiModelName = value;
					await this.plugin.saveSettings();
				}));
		// }

		// // OpenRouter Settings Group
		// if (this.plugin.settings.provider === 'openrouter') {
		// 	containerEl.createEl('h3', { text: 'OpenRouter Settings' });
		// 	// OpenRouter API Key Setting
		// 	const openrouterApiKeySetting = new Setting(containerEl)
		// 		.setName('OpenRouter API Key')
		// 		.setDesc('Your API key for OpenRouter.');

		// 	const openrouterApiKeyInput = openrouterApiKeySetting.addText(text => text
		// 		.setPlaceholder('Enter your OpenRouter API key')
		// 		.setValue(this.plugin.settings.openrouterApiKey)
		// 		.onChange(async (value) => {
		// 			this.plugin.settings.openrouterApiKey = value;
		// 			await this.plugin.saveSettings();
		// 		}));

		// 	openrouterApiKeySetting.addButton(button => button
		// 		.setButtonText('Validate')
		// 		.onClick(async () => {
		// 			const isValid = await this.plugin.openrouterService.validateApi();
		// 			if (isValid) {
		// 				new Notice('OpenRouter API key is valid!');
		// 			}
		// 		}));

		// 	// OpenRouter Model Name Setting
		// 	new Setting(containerEl)
		// 		.setName('OpenRouter Model Name')
		// 		.setDesc('The model to use for transcription (e.g., openai/whisper-large-v3).')
		// 		.addText(text => text
		// 			.setPlaceholder('e.g., openai/whisper-large-v3')
		// 			.setValue(this.plugin.settings.openrouterModelName)
		// 			.onChange(async (value) => {
		// 				this.plugin.settings.openrouterModelName = value;
		// 				await this.plugin.saveSettings();
		// 			}));
		// }


		// Common Settings
		containerEl.createEl('h2', { text: 'Common Settings' });

		const promptSetting = new Setting(containerEl)
			.setName('Transcription Prompt')
			.setDesc('The prompt to use when transcribing audio. This is used by Gemini but not by OpenRouter Whisper models.');

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

