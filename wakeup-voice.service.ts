import {Injectable, NgZone} from '@angular/core';

@Injectable({
  providedIn: 'root',
})
export class WakeupVoiceService {
  private recognition: any;
  private isListening = false;
  private wakeWord = 'hey buddy'; // Removed comma for better matching
  private wakeupCallback: () => void = () => {
    console.log('[VoiceWakeup] Default wakeup callback');
  };
  private workOrderCallback: (transcript: string) => void = () => {
    console.log('[VoiceWakeup] Default work order callback');
  };

  constructor(private readonly zone: NgZone) {
    console.log('[VoiceWakeup] Service initialized');

    const SpeechRecognition =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.error('[VoiceWakeup] SpeechRecognition is not supported in this browser.');
      return;
    }

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.lang = 'en-US';
    this.recognition.interimResults = false;

    this.recognition.onstart = () => {
      console.log('[VoiceWakeup] Recognition started');
    };

    this.recognition.onerror = (event) => {
      console.error(`[VoiceWakeup] ❌ Speech recognition error: ${event.error}`);
      // event.message might not always be available or standard, but can be helpful for debugging
      if (event.message) {
        console.error(`[VoiceWakeup] Error message (non-standard but informative): ${event.message}`);
      }

      // Implement specific error handling logic based on event.error
      switch (event.error) {
        case 'no-speech':
          console.log('[VoiceWakeup] No speech detected. The microphone might be off or the user is not speaking.');
          // Continue listening - this is normal for wake word detection
          break;
        case 'audio-capture':
          console.log('[VoiceWakeup] Microphone not available or audio input device issues.');
          this.isListening = false; // Stop on critical audio issues
          break;
        case 'not-allowed':
          console.log('[VoiceWakeup] Microphone access denied by the user or browser policy.');
          this.isListening = false; // Stop as we can't proceed without permission
          break;
        case 'network':
          console.log('[VoiceWakeup] Network error occurred during speech recognition.');
          break;
        case 'aborted':
          console.log('[VoiceWakeup] Speech recognition was aborted.');
          // This is often caused by AudioContext restrictions - don't restart automatically
          this.isListening = false;
          break;
        case 'bad-grammar':
          console.log('[VoiceWakeup] Bad grammar error occurred during speech recognition.');
          break;
        case 'language-not-supported':
          console.log('[VoiceWakeup] The specified language is not supported.');
          this.isListening = false;
          break;
        case 'service-not-allowed':
          console.log('[VoiceWakeup] The speech recognition service is not allowed.');
          this.isListening = false;
          break;
        default:
          console.log(`[VoiceWakeup] An unknown speech recognition error occurred: ${event.error}`);
          break;
      }
    };
    this.recognition.onresult = (event: any) => {
      const transcript = event.results[event.resultIndex][0].transcript.trim().toLowerCase();
      console.log('[VoiceWakeup] 🎤 Heard:', transcript);
      console.log('[VoiceWakeup] 👀 Looking for wake word:', this.wakeWord);
      
      // Check for wake word - more flexible matching (removes punctuation)
      const normalizedTranscript = transcript.replaceAll(/[,.!?]/g, '').trim();
      const normalizedWakeWord = this.wakeWord.replaceAll(/[,.!?]/g, '').trim();
      
      if (normalizedTranscript.includes(normalizedWakeWord)) {
        console.log('[VoiceWakeup] ✅ Wake word detected!');
        this.zone.run(() => this.wakeupCallback());
        return;
      }
      
      // Check for work order command patterns:
      console.log('[VoiceWakeup] 🔍 Testing work order patterns against:', transcript);
      // Pattern 1: "help me fix WO-20241009" or "help me to fix WO-20241009"
      // Pattern 2: "help me fix work order 20241009" or "help me to fix work order 20241009"
      // Pattern 3: "help me to fix work order 20241009" (more specific)
      // Pattern 4: "resume work order 20241009" or "resume the work order 20241009"
      // Pattern 5: "restart work order 20241009" or "restart the work order 20241009"
      // Pattern 6: "start work 20241009" or "start work order 20241009"
      const workOrderPattern1 = /help\s+me\s+(?:to\s+)?fix\s+(?:wo[-\s]?)?(\d+(?:\s*\d+)*)/i;
      const workOrderPattern2 = /help\s+me\s+(?:to\s+)?fix\s+work\s+order\s+(\d+(?:\s*\d+)*)/i;
      const workOrderPattern3 = /help\s+me\s+to\s+fix\s+work\s+order\s+(\d+(?:\s*\d+)*)/i;
      const resumePattern = /resume\s+(?:the\s+)?(?:work\s*order\s*|wo[-\s]?)(\d+(?:\s*\d+)*)/i;
      const restartPattern = /restart\s+(?:the\s+)?(?:work\s*order\s*|wo[-\s]?)(\d+(?:\s*\d+)*)/i;
      const startPattern = /start\s+(?:work\s*order\s*|work\s+)(\d+(?:\s*\d+)*)/i;
      
      let match = null;
      let workOrderId = '';
      let detectedCommand = '';
      
      // Try all patterns
      match = resumePattern.exec(transcript);
      if (match) {
        const numberPart = match[1].replaceAll(/\s+/g, '');
        workOrderId = `WO-${numberPart}`;
        detectedCommand = 'resume';
        console.log('[VoiceWakeup] ✓ RESUME work order command detected:', workOrderId);
      }
      
      if (!match) {
        match = restartPattern.exec(transcript);
        if (match) {
          const numberPart = match[1].replaceAll(/\s+/g, '');
          workOrderId = `WO-${numberPart}`;
          detectedCommand = 'restart';
          console.log('[VoiceWakeup] ✓ RESTART work order command detected:', workOrderId);
        }
      }
      
      if (!match) {
        match = startPattern.exec(transcript);
        if (match) {
          const numberPart = match[1].replaceAll(/\s+/g, '');
          workOrderId = `WO-${numberPart}`;
          detectedCommand = 'start';
          console.log('[VoiceWakeup] ✓ START work order command detected:', workOrderId);
        }
      }
      
      if (!match) {
        match = workOrderPattern3.exec(transcript);
        if (match) {
          const numberPart = match[1].replaceAll(/\s+/g, '');
          workOrderId = `WO-${numberPart}`;
          detectedCommand = 'help';
          console.log('[VoiceWakeup] ✓ Work order command detected (help pattern 3 - "to fix work order"):', workOrderId);
        }
      }
      
      if (!match) {
        match = workOrderPattern2.exec(transcript);
        if (match) {
          const numberPart = match[1].replaceAll(/\s+/g, '');
          workOrderId = `WO-${numberPart}`;
          detectedCommand = 'help';
          console.log('[VoiceWakeup] ✓ Work order command detected (help pattern 2):', workOrderId);
        }
      }
      
      if (!match) {
        match = workOrderPattern1.exec(transcript);
        if (match) {
          const numberPart = match[1].replaceAll(/\s+/g, '');
          workOrderId = `WO-${numberPart}`;
          detectedCommand = 'help';
          console.log('[VoiceWakeup] ✓ Work order command detected (help pattern 1):', workOrderId);
        }
      }
      
      if (workOrderId) {
        console.log('[VoiceWakeup] 🎯 WORK ORDER COMMAND DETECTED!');
        console.log('[VoiceWakeup] 📋 Final work order ID:', workOrderId);
        console.log('[VoiceWakeup] 🎬 Command type:', detectedCommand);
        console.log('[VoiceWakeup] 📝 Original transcript:', transcript);
        // Pass the original transcript to maintain the command context
        this.zone.run(() => this.workOrderCallback(transcript));
      } else {
        console.log('[VoiceWakeup] ❌ No work order command patterns matched');
      }
    };

    this.recognition.onend = () => {
      console.log('[VoiceWakeup] Recognition ended. isListening:', this.isListening);
      
      // Only auto-restart if we're supposed to be listening
      if (this.isListening) {
        // Mark as not listening temporarily to allow restart
        this.isListening = false;
        
        // Add a delay and check before restarting
        setTimeout(() => {
          if (!this.isListening && this.recognition && this.wakeupCallback) {
            console.log('[VoiceWakeup] Auto-restarting recognition...');
            this.startListening(this.wakeupCallback, this.workOrderCallback);
          }
        }, 500); // Safe restart with delay
      }
    };

    this.recognition.onnomatch = () => {
      console.warn('[VoiceWakeup] No match for speech input');
    };
  }

  /**
   * Start wake word detection
   * @param callback Function to call when wake word is detected
   * @param workOrderCallback Function to call when work order command is detected
   */
  startListening(callback: () => void, workOrderCallback?: (transcript: string) => void): void {
    if (!this.recognition) {
      console.error('[VoiceWakeup] Cannot start listening - recognition not initialized');
      return;
    }

    if (this.isListening) {
      console.warn('[VoiceWakeup] startListening called, but recognition is already active.');
      return; // Don't try to restart if already listening
    }

    console.log('[VoiceWakeup] 🎤 Starting wake word listener...');
    console.log('[VoiceWakeup] Wake word:', this.wakeWord);
    this.wakeupCallback = callback;
    if (workOrderCallback) {
      this.workOrderCallback = workOrderCallback;
    }
    
    try {
      this.recognition.start();
      this.isListening = true;
      console.log('[VoiceWakeup] ✓ Recognition started successfully');
    } catch (error: any) {
      console.error('[VoiceWakeup] ✗ Error starting recognition:', error);
      
      // Check if it's the "already started" error
      if (error.message && error.message.includes('already started')) {
        console.warn('[VoiceWakeup] ⚠️ Recognition was already running, setting flag to true');
        this.isListening = true; // Sync the flag with actual state
      } else {
        this.isListening = false;
        throw error;
      }
    }
  }

  /**
   * Stop wake word detection
   */
  stopListening(): void {
    if (!this.recognition) return;

    console.log('[VoiceWakeup] Listening stopped');
    this.isListening = false;
    this.recognition.stop();
  }
}
