// Import required modules
const Mic = require("mic"); // Use the "mic" package
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
let micInstance, micInputStream, outputFile, rl, recorder, porcupine;
let isInterrupted = false;
let chatHistory = [];

// PicoVoice Key
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
  if (micInstance) {
    try {
      micInstance.stop();
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

// Start recording with the "mic" package
const startRecording = () => {
  try {
    micInstance = Mic({
      rate: "16000",
      channels: "1",
      debug: false,
      exitOnSilence: 2, // Automatically detect silence
      fileType: "wav",
    });

    outputFile = fs.createWriteStream("output.wav");
    micInputStream = micInstance.getAudioStream();

    micInputStream.on("data", (data) => {
      try {
        if (!outputFile.closed) {
          outputFile.write(data);
        }
      } catch (e) {
        console.error("Error writing audio data:", e);
        cleanup();
      }
    });

    micInputStream.on("error", (error) => {
      console.error("Microphone Error:", error);
      cleanup();
    });

    micInputStream.on("silence", () => {
      console.log("Detected silence.");
      stopRecordingAndProcess();
    });

    micInstance.start();
    console.log("Recording... Will stop after 2 seconds of slience.");
  } catch (error) {
    console.error("Error in startRecording:", error);
    cleanup();
  }
};

const stopRecordingAndProcess = () => {
  try {
    if (micInstance) micInstance.stop();

    if (micInputStream) {
      micInputStream.removeAllListeners(); // Clean up listeners to prevent further events
    }

    if (outputFile) {
      outputFile.end(() => {
        console.log(`Recording stopped, processing audio...`);
        transcribeAndChat(); // Continue processing the audio file
      });
    }
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
  form.append("language", "en"); // Specify English language

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
          "You are a helpful assistant, named Cact GPT. You were a children's cactus toy that has been modified to be my office assistant. You will assist me by answering my questions in no more than two sentences. Please ask if I'd like to hear more if your response will be over two sentences.",
      },
      ...chatHistory,
      { role: "user", content: transcribedText },
    ];

    const chatResponse = await openai.chat.completions.create({
      messages: messages,
      model: "gpt-4o",
    });

    const chatResponseText = chatResponse.choices[0].message.content;

    chatHistory.push(
      { role: "user", content: transcribedText },
      { role: "assistant", content: chatResponseText }
    );

    console.log(`>> Assistant said: ${chatResponseText}`);
    await streamedAudio(chatResponseText);

    startWakeWordDetection();

    micStream = null;

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
  console.log(`Listening for 'Hey Cactus'.`);
  try {
    porcupine = new Porcupine(
      accessKey,
      ['cactus.ppn'],
      [.95]
    );

    const frameLength = porcupine.frameLength;
    recorder = new PvRecorder(frameLength, -1);
    
    await recorder.start();

    while (!isInterrupted) {
      const pcm = await recorder.read();
      const index = porcupine.process(pcm);
      
      if (index !== -1) {
        console.log(`Wake word "Hey Cactus" detected!`);
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
startWakeWordDetection();