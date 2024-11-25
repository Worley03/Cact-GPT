// Import required modules
const Microphone = require("node-microphone");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const readline = require("readline");
const axios = require("axios");
const FormData = require("form-data");
const Speaker = require("speaker");
const OpenAI = require("openai");
require("dotenv").config();
const { PvRecorder } = require("@picovoice/pvrecorder-node");
const { Porcupine } = require("@picovoice/porcupine-node");

// Initialize variables
let mic, outputFile, micStream, rl, recorder, porcupine;
let isInterrupted = false;
let chatHistory = [];

const accessKey = process.env.accessKey;

// Initialize OpenAI
const secretKey = process.env.OPENAI_API_KEY;
const openai = new OpenAI({
  apiKey: secretKey,
});

// Set FFmpeg path
ffmpeg.setFfmpegPath(ffmpegPath);

// Welcome message
console.log(
  `\n# # # # # # # # # # # # # # # # # # # # #\n# Welcome to your AI-powered voice chat #\n# # # # # # # # # # # # # # # # # # # # #\n`
);

// Proper cleanup function
const cleanup = () => {
  if (mic) {
    try {
      mic.stopRecording();
    } catch (e) {
      console.error("Error stopping microphone:", e);
    }
  }
  
  if (outputFile) {
    outputFile.end();
  }
  
  if (recorder) {
    try {
      recorder.stop();
      recorder.release();
    } catch (e) {
      console.error("Error releasing recorder:", e);
    }
  }
  
  if (porcupine) {
    try {
      porcupine.release();
    } catch (e) {
      console.error("Error releasing porcupine:", e);
    }
  }
  
  if (rl) {
    rl.close();
  }

  process.exit(0);
};

// Setup readline interface with proper error handling
const setupReadlineInterface = () => {
  try {
    rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });

    readline.emitKeypressEvents(process.stdin, rl);

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    process.stdin.on("keypress", (str, key) => {
      if (key && (key.name === "return" || key.name === "enter")) {
        if (micStream) {
          stopRecordingAndProcess();
        } else {
          startRecording();
        }
      } else if (key && key.ctrl && key.name === "c") {
        cleanup();
      }
    });

    // Handle process termination
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    process.on('uncaughtException', (error) => {
      console.error('Uncaught Exception:', error);
      cleanup();
    });

    console.log("Press Enter when you're ready to start speaking.");
  } catch (error) {
    console.error("Error in setupReadlineInterface:", error);
    cleanup();
  }
};

// Start recording with error handling
const startRecording = () => {
  try {
    mic = new Microphone();
    outputFile = fs.createWriteStream("output.wav");
    micStream = mic.startRecording();

    micStream.on("data", (data) => {
      try {
        outputFile.write(data);
      } catch (e) {
        console.error("Error writing audio data:", e);
        cleanup();
      }
    });

    micStream.on("error", (error) => {
      console.error("Microphone Error:", error);
      cleanup();
    });

    console.log("Recording... Press Enter to stop");
  } catch (error) {
    console.error("Error in startRecording:", error);
    cleanup();
  }
};

// Stop recording and process the audio
const stopRecordingAndProcess = () => {
  try {
    mic.stopRecording();
    outputFile.end();
    console.log(`Recording stopped, processing audio...`);
    transcribeAndChat();
  } catch (error) {
    console.error("Error in stopRecordingAndProcess:", error);
    cleanup();
  }
};

// Default voice settings
const inputVoice = "echo";
const inputModel = "tts-1";

async function streamedAudio(inputText, model = inputModel, voice = inputVoice) {
  const url = "https://api.openai.com/v1/audio/speech";
  const headers = {
    Authorization: `Bearer ${secretKey}`,
  };

  const data = {
    model: model,
    input: inputText,
    voice: voice,
    response_format: "mp3",
  };

  try {
    const response = await axios.post(url, data, {
      headers: headers,
      responseType: "stream",
    });

    const speaker = new Speaker({
      channels: 2,
      bitDepth: 16,
      sampleRate: 44100,
    });

    return new Promise((resolve, reject) => {
      ffmpeg(response.data)
        .toFormat("s16le")
        .audioChannels(2)
        .audioFrequency(44100)
        .on('error', (err) => {
          console.error('FFmpeg error:', err);
          reject(err);
        })
        .on('end', () => {
          // This event fires when ffmpeg finishes processing
          speaker.on('close', () => {
            // This event fires when the speaker finishes playing
            resolve();
          });
        })
        .pipe(speaker);
    });

  } catch (error) {
    if (error.response) {
      console.error(
        `Error with HTTP request: ${error.response.status} - ${error.response.statusText}`
      );
    } else {
      console.error(`Error in streamedAudio: ${error.message}`);
    }
    throw error;
  }
}

async function transcribeAndChat() {
  const filePath = "output.wav";

  const form = new FormData();
  form.append("file", fs.createReadStream(filePath));
  form.append("model", "whisper-1");
  form.append("response_format", "text");

  try {
    const transcriptionResponse = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      form,
      {
        headers: {
          ...form.getHeaders(),
          Authorization: `Bearer ${secretKey}`,
        },
      }
    );

    const transcribedText = transcriptionResponse.data;
    console.log(`>> You said: ${transcribedText}`);

    const messages = [
      {
        role: "system",
        content:
          "You are a helpful assistant providing concise responses in at most two sentences.",
      },
      ...chatHistory,
      { role: "user", content: transcribedText },
    ];

    const chatResponse = await openai.chat.completions.create({
      messages: messages,
      model: "gpt-4o-mini",
    });

    const chatResponseText = chatResponse.choices[0].message.content;

    chatHistory.push(
      { role: "user", content: transcribedText },
      { role: "assistant", content: chatResponseText }
    );

    console.log(`>> Assistant said: ${chatResponseText}`);
    await streamedAudio(chatResponseText);

    micStream = null;
    console.log("Press Enter to speak again, or any other key to quit.\n");
    
    // Call startRecording after audio streaming is complete
    startRecording();
    
  } catch (error) {
    if (error.response) {
      console.error(
        `Error: ${error.response.status} - ${error.response.statusText}`
      );
    } else {
      console.error("Error:", error.message);
    }
    cleanup();
  }
}

// Initialize wake word detection with proper error handling
const startWakeWordDetection = async () => {
  try {
    porcupine = new Porcupine(
      accessKey,
      ['cactus.ppn'],
      [1]
    );

    const frameLength = porcupine.frameLength;
    recorder = new PvRecorder(frameLength, -1);
    
    await recorder.start();

    while (!isInterrupted) {
      const pcm = await recorder.read();
      const index = porcupine.process(pcm);
      
      if (index !== -1) {
        console.log(`Wake word "Cactus" detected!`);
        await recorder.stop();
        recorder.release();
        porcupine.release();
        startRecording();
        return;
      }
    }
  } catch (error) {
    console.error("Error in wake word detection:", error);
    cleanup();
  }
};

// Initialize the application
setupReadlineInterface();
startWakeWordDetection();