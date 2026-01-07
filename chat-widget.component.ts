import {Component, OnInit, OnDestroy, ChangeDetectorRef} from '@angular/core';
import {CommonModule} from '@angular/common';
import {ButtonModule} from 'primeng/button';
import {InputTextareaModule} from 'primeng/inputtextarea';
import {AvatarModule} from 'primeng/avatar';
import {FormsModule} from '@angular/forms';
import {TooltipModule} from 'primeng/tooltip';
import {Router} from '@angular/router';
import {VoiceApiService} from './voice-api.service';
import {WakeupVoiceService} from './wakeup-voice.service';
import {ChatCommunicationService} from '../services/chat-communication.service';
import {FeedbackService} from '../services/feedback.service';
import {WorkOrderActionService} from '../services/work-order-action.service';
import {AzureSpeechService} from '../services/azure-speech.service';
import {Subscription} from 'rxjs';

@Component({
  selector: 'app-chat-widget',
  standalone: true,
  imports: [
    CommonModule,
    ButtonModule,
    InputTextareaModule,
    AvatarModule,
    FormsModule,
    TooltipModule,
  ],
  templateUrl: './chat-widget.component.html',
  styleUrls: ['./chat-widget.component.scss'],
})
export class ChatWidgetComponent implements OnInit, OnDestroy {
  
  isChatOpen = false;
  userInput = '';
  isRecording = false;
  isListening = false;
  isProcessing = false;
  isUserTyping = false; // Track if user is actively typing
  isVoicePlaying = false; // Track if voice output is playing
  isFeedbackInProgress = false; // Track if feedback is being submitted
  private readonly mediaRecorder: MediaRecorder | null = null;
  private readonly audioChunks: Blob[] = [];
  private autoOpenTimer: any = null;
  private autoCloseTimer: any = null;
  private readonly AUTO_CLOSE_DELAY = 30000; // 30 seconds
  private messageSubscription: Subscription | null = null;
  private azureSpeechResultSubscription: Subscription | null = null;
  private azureSpeechErrorSubscription: Subscription | null = null;
  private azureSpeechEndSubscription: Subscription | null = null;
  messages: {
    text: string; 
    sender: 'user' | 'bot'; 
    avatar: string; 
    isProcessing?: boolean;
    isVoice?: boolean;
    stepNumber?: number;
    sessionId?: string;
    feedback?: 'positive' | 'negative' | null;
  }[] = [
    {text: 'Hello! How can I help you today?', sender: 'bot', avatar: '🤖'},
  ];
  private currentStepNumber = 0;
  private currentSessionId = '';

  constructor(
    private readonly voiceApiService: VoiceApiService,
    private readonly voiceWakeup: WakeupVoiceService,
    private readonly chatService: ChatCommunicationService,
    private readonly cdr: ChangeDetectorRef,
    private readonly feedbackService: FeedbackService,
    private readonly router: Router,
    private readonly workOrderActionService: WorkOrderActionService,
    private readonly azureSpeechService: AzureSpeechService
  ) {
    const instanceId = Math.random().toString(36).substring(7);
    console.log(`[ChatWidget] 🏗️ Component constructor called [Instance: ${instanceId}]`);
    console.trace('[ChatWidget] Constructor call stack');
    this.initializeMediaRecorder();
    this.initializeAzureSpeech();
  }

  ngOnInit() {
    console.log('[ChatWidget] Component initialized - ngOnInit called');
    // Get session ID if available
    const sessionId = sessionStorage.getItem('current_session_id');
    if (sessionId) {
      this.currentSessionId = sessionId;
    }

    // Subscribe to incoming messages from other components
    this.messageSubscription = this.chatService.message$.subscribe(async (message) => {
      if (message.autoOpen && !this.isChatOpen) {
        this.toggleChat();
      }
      
      // Increment step number for tracking
      this.currentStepNumber++;
      
      // Add bot message with feedback tracking
      this.messages.push({
        text: message.text,
        sender: 'bot',
        avatar: '🤖',
        sessionId: this.currentSessionId,
        stepNumber: this.currentStepNumber,
        feedback: null
      });
      
      this.scrollToBottom();
      
      // Play voice if requested
      if (message.isVoice) {
        try {
          this.isVoicePlaying = true;
          await this.voiceApiService.speakText(message.text);
          this.isVoicePlaying = false;
          // Notify that voice synthesis is complete
          this.chatService.notifyVoiceComplete();
        } catch (error) {
          console.error('Error with text-to-speech:', error);
          this.isVoicePlaying = false;
        }
      }
    });
    
    // Auto-open chat widget after 10 seconds
    // this.autoOpenTimer = setTimeout(() => {
    //   if (!this.isChatOpen) {
    //     this.toggleChat();
    //   }
    // }, 10000); // 10 seconds
    // this.voiceWakeup.startListening(() => {
    //   console.log('Wake word detected!');
    //   this.voiceWakeup.stopListening();

    //   if (!this.isChatOpen) {
    //     this.toggleChat();
    //     // Add a small delay to prevent a race condition for the microphone
    //     setTimeout(() => {
    //       this.toggleVoiceInput();
    //     }, 300); // 300ms is usually a safe delay
    //   }
    // });
    this.startWakeWordListener();
  }

  private async initializeMediaRecorder() {
    // We're now using speech recognition instead of MediaRecorder
    // This method is kept for compatibility but doesn't initialize MediaRecorder
    console.log('Using Speech Recognition API instead of MediaRecorder');
  }

  private initializeAzureSpeech() {
    console.log('[ChatWidget] 🎤 Initializing Azure Speech Service');
    
    // Unsubscribe from any existing subscriptions to prevent duplicates
    if (this.azureSpeechResultSubscription) {
      console.warn('[ChatWidget] ⚠️ Found existing Azure Speech result subscription - unsubscribing');
      this.azureSpeechResultSubscription.unsubscribe();
      this.azureSpeechResultSubscription = null;
    }
    
    if (this.azureSpeechErrorSubscription) {
      console.warn('[ChatWidget] ⚠️ Found existing Azure Speech error subscription - unsubscribing');
      this.azureSpeechErrorSubscription.unsubscribe();
      this.azureSpeechErrorSubscription = null;
    }
    
    if (this.azureSpeechEndSubscription) {
      console.warn('[ChatWidget] ⚠️ Found existing Azure Speech end subscription - unsubscribing');
      this.azureSpeechEndSubscription.unsubscribe();
      this.azureSpeechEndSubscription = null;
    }
    
    // Subscribe to recognition results
    this.azureSpeechResultSubscription = this.azureSpeechService.onResult$.subscribe(
      async (result) => {
        console.log(`[ChatWidget] ${result.isFinal ? '✅ Final' : '🎤 Interim'} result:`, result.transcript);
        
        // Only process final results
        if (result.isFinal && result.transcript.trim()) {
          const finalTranscript = result.transcript.trim();
          
          console.log('[ChatWidget] ✅ Processing Azure Speech final result:', finalTranscript);
          
          // Stop recognition to process this result
          this.isRecording = false;
          await this.azureSpeechService.stopContinuousRecognition();
          
          // Add user message with voice indicator
          this.messages.push({
            text: finalTranscript,
            sender: 'user',
            avatar: '🧑',
            isVoice: true
          });

          this.cdr.detectChanges(); // Force immediate UI update
          this.scrollToBottom();

          // Send transcribed text to API and get voice response
          // Pass userMessageAlreadyAdded=true since we just added it above
          await this.sendTranscriptToAPI(finalTranscript, true, true);
          
          // Restart wake word listener after processing is complete
          this.startWakeWordListener();
        }
      }
    );

    // Subscribe to recognition errors
    this.azureSpeechErrorSubscription = this.azureSpeechService.onError$.subscribe(
      (error) => {
        console.error('[ChatWidget] ❌ Azure Speech error:', error);
        this.isRecording = false;
        
        // Show user-friendly error message
        if (error.includes('authorization') || error.includes('Forbidden')) {
          this.showErrorMessage('Speech service authentication failed. Please check your Azure credentials.');
        } else if (error.includes('network') || error.includes('timeout')) {
          this.showErrorMessage('Network error. Please check your internet connection and try again.');
        } else {
          this.showErrorMessage('Voice recognition failed. Please try again.');
        }
      }
    );

    // Subscribe to recognition end events
    this.azureSpeechEndSubscription = this.azureSpeechService.onEnd$.subscribe(
      () => {
        console.log('[ChatWidget] 🛑 Azure Speech recognition ended');
        this.isRecording = false;
        this.cdr.detectChanges();
      }
    );
  }

  private async sendVoiceToAPI(audioBlob: Blob): Promise<void> {
    // This method is no longer used since we're using browser speech recognition
    // The voice input is now handled through the speech recognition API directly
    console.warn('sendVoiceToAPI called but not used in speech recognition mode');
  }

  private async sendTranscriptToAPI(transcript: string, isVoiceInput: boolean = false, userMessageAlreadyAdded: boolean = false): Promise<void> {
    try {
      // Reset auto-close timer on user interaction
      this.resetAutoCloseTimer();
      
      console.log('[ChatWidget] 🔍 Processing transcript:', transcript);
      console.log('[ChatWidget] 📝 Transcript length:', transcript.length);
      console.log('[ChatWidget] 🎤 Is voice input:', isVoiceInput);
      console.log('[ChatWidget] 💬 User message already added:', userMessageAlreadyAdded);
      
      // Check if this is a restart work order command (e.g., "restart work order 20241007")
      const restartPattern = /restart\s+(?:the\s+)?(?:work\s*order\s*|wo[-\s]?)(\d+)/i;
      const restartMatch = transcript.match(restartPattern);
      
      if (restartMatch) {
        const workOrderNumber = restartMatch[1];
        console.log('[ChatWidget] ✅ Restart work order command detected:', workOrderNumber);
        
        // Add user message only if not already added
        if (!userMessageAlreadyAdded) {
          this.messages.push({
            text: transcript,
            sender: 'user',
            avatar: '👤',
            isVoice: isVoiceInput,
          });
          
          this.cdr.detectChanges();
          this.scrollToBottom();
        }
        
        // Stop widget voice recognition
        this.pauseVoiceRecognition();
        
        // Close the chat widget
        this.toggleChat();
        
        // Trigger the action - this will open the modal
        const fullWorkOrderNumber = `WO-${workOrderNumber}`;
        console.log('[ChatWidget] 🚀 Triggering RESTART action for:', fullWorkOrderNumber);
        this.workOrderActionService.triggerAction(fullWorkOrderNumber, 'restart');
        
        // ALSO store in sessionStorage as backup (for when navigating to page)
        sessionStorage.setItem('pending_work_order_action', JSON.stringify({
          orderNumber: fullWorkOrderNumber,
          action: 'restart'
        }));
        console.log('[ChatWidget] ✅ Action triggered and stored in sessionStorage');
        
        // Navigate to work orders page
        setTimeout(() => {
          console.log('[ChatWidget] 📍 Navigating to /work-order...');
          this.router.navigate(['/work-order']).then(() => {
            console.log('[ChatWidget] ✅ Navigation completed');
          });
        }, 300);
        
        return;
      }
      
      // Check if this is a resume work order command (e.g., "resume work order 20241008")
      const resumePattern = /resume\s+(?:the\s+)?(?:work\s*order\s*|wo[-\s]?)(\d+)/i;
      const resumeMatch = transcript.match(resumePattern);
      
      if (resumeMatch) {
        const workOrderNumber = resumeMatch[1];
        console.log('[ChatWidget] ✅ Resume work order command detected:', workOrderNumber);
        
        // Add user message only if not already added
        if (!userMessageAlreadyAdded) {
          this.messages.push({
            text: transcript,
            sender: 'user',
            avatar: '👤',
            isVoice: isVoiceInput,
          });
          
          this.cdr.detectChanges();
          this.scrollToBottom();
        }
        
        // Stop widget voice recognition
        this.pauseVoiceRecognition();
        
        // Close the chat widget
        this.toggleChat();
        
        // Trigger the action - this will open the modal
        const fullWorkOrderNumber = `WO-${workOrderNumber}`;
        console.log('[ChatWidget] 🚀 Triggering RESUME action for:', fullWorkOrderNumber);
        this.workOrderActionService.triggerAction(fullWorkOrderNumber, 'resume');
        
        // ALSO store in sessionStorage as backup (for when navigating to page)
        sessionStorage.setItem('pending_work_order_action', JSON.stringify({
          orderNumber: fullWorkOrderNumber,
          action: 'resume'
        }));
        console.log('[ChatWidget] ✅ Action triggered and stored in sessionStorage');
        
        // Navigate to work orders page
        setTimeout(() => {
          console.log('[ChatWidget] 📍 Navigating to /work-order...');
          this.router.navigate(['/work-order']).then(() => {
            console.log('[ChatWidget] ✅ Navigation completed');
          });
        }, 300);
        
        return;
      }
      
      // Check if this is a start work order command with multiple variations:
      // - "help me fix work order 20241008"
      // - "help me to fix work order 20241008"
      // - "start work 20241008"
      // - "start work order 20241008"
      const helpPattern = /help\s+me\s+(?:to\s+)?fix\s+(?:work\s*order\s*|wo[-\s]?)(\d+)/i;
      const startPattern = /start\s+(?:work\s*order\s*|work\s+)(\d+)/i;
      
      const helpMatch = transcript.match(helpPattern);
      const startMatch = transcript.match(startPattern);
      
      const workOrderMatch = helpMatch || startMatch;
      
      if (workOrderMatch) {
        const workOrderNumber = workOrderMatch[1];
        console.log('[ChatWidget] ✅ Work order start command detected:', workOrderNumber);
        
        // Add user message only if not already added
        if (!userMessageAlreadyAdded) {
          this.messages.push({
            text: transcript,
            sender: 'user',
            avatar: '👤',
            isVoice: isVoiceInput,
          });
          
          this.cdr.detectChanges();
          this.scrollToBottom();
        }
        
        // Stop widget voice recognition
        this.pauseVoiceRecognition();
        
        // Close the chat widget
        this.toggleChat();
        
        // Trigger the action - this will open the modal
        const fullWorkOrderNumber = `WO-${workOrderNumber}`;
        console.log('[ChatWidget] 🚀 Triggering START action for:', fullWorkOrderNumber);
        this.workOrderActionService.triggerAction(fullWorkOrderNumber, 'start');
        
        // ALSO store in sessionStorage as backup (for when navigating to page)
        sessionStorage.setItem('pending_work_order_action', JSON.stringify({
          orderNumber: fullWorkOrderNumber,
          action: 'start'
        }));
        console.log('[ChatWidget] ✅ Action triggered and stored in sessionStorage');
        
        // Navigate to work orders page
        setTimeout(() => {
          console.log('[ChatWidget] 📍 Navigating to /work-order...');
          this.router.navigate(['/work-order']).then(() => {
            console.log('[ChatWidget] ✅ Navigation completed');
          });
        }, 300); // Delay to allow widget to close smoothly
        
        return;
      }
      
      // Update session ID if changed
      const sessionId = sessionStorage.getItem('current_session_id');
      if (sessionId) {
        this.currentSessionId = sessionId;
      }

      // Add processing indicator for bot response
      const botMessageIndex = this.messages.length;
      this.messages.push({
        text: '🤔 Thinking...',
        sender: 'bot',
        avatar: '🤖',
        isProcessing: true,
      });

      this.cdr.detectChanges(); // Force immediate UI update
      this.scrollToBottom();

      // Get response from chat API, passing the input type
      console.log('[ChatWidget] 🔵 Calling sendTextToAPI with isVoiceInput:', isVoiceInput);
      const botResponse = await this.voiceApiService.sendTextToAPI(transcript, isVoiceInput);

      // Increment step number for tracking
      this.currentStepNumber++;

      // Update bot message with actual response and voice indicator
      this.messages[botMessageIndex] = {
        text: botResponse,
        sender: 'bot',
        avatar: '🤖',
        isVoice: isVoiceInput, // Mark as voice if input was voice
        sessionId: this.currentSessionId,
        stepNumber: this.currentStepNumber,
        feedback: null
      };

      this.cdr.detectChanges(); // Force immediate UI update
      this.scrollToBottom();

      // Speak the response using text-to-speech (only if input was voice)
      if (isVoiceInput) {
        // Prevent playing if already playing
        if (this.isVoicePlaying) {
          console.warn('[ChatWidget] ⚠️ Voice already playing, skipping duplicate');
          return;
        }
        
        try {
          console.log('[ChatWidget] 🔊 Starting voice output for bot response');
          this.isVoicePlaying = true;
          await this.voiceApiService.speakText(botResponse);
          this.isVoicePlaying = false;
          console.log('[ChatWidget] ✅ Voice output completed');
          // Notify that voice synthesis is complete
          this.chatService.notifyVoiceComplete();
        } catch (ttsError) {
          console.error('[ChatWidget] ❌ Error with text-to-speech:', ttsError);
          this.isVoicePlaying = false;
        }
      }
      
      // Reset auto-close timer after bot responds
      this.resetAutoCloseTimer();

      this.startWakeWordListener();
    } catch (error) {
      console.error('Chat API error:', error);
      this.messages[this.messages.length - 1] = {
        text: 'Sorry, I encountered an error. Please try again.',
        sender: 'bot',
        avatar: '🤖',
      };
      this.cdr.detectChanges(); // Force immediate UI update
      this.scrollToBottom();

      this.startWakeWordListener();
    }
  }

  private showErrorMessage(message: string): void {
    this.messages.push({
      text: message,
      sender: 'bot',
      avatar: '🤖',
    });
    this.scrollToBottom();
  }

  get isSpeechSupported(): boolean {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  }

  get isMediaRecorderSupported(): boolean {
    // We're not using MediaRecorder anymore, so return false
    return false;
  }

  /**
   * Resume AudioContext if suspended (required by browser policy)
   * Must be called on user interaction (click, touch, etc.)
   */
  private resumeAudioContextIfNeeded(): void {
    // Check if there's a global AudioContext that needs resuming
    if (typeof AudioContext !== 'undefined' || typeof (window as any).webkitAudioContext !== 'undefined') {
      const AudioCtx = (window as any).AudioContext || (window as any).webkitAudioContext;
      
      // Try to access and resume any suspended AudioContext
      try {
        // Note: Azure Speech SDK manages its own AudioContext
        // But we can still trigger user gesture for browser permissions
        console.log('[ChatWidget] 🔊 User interaction detected - audio permissions granted');
      } catch (error) {
        console.warn('[ChatWidget] ⚠️ AudioContext resume warning (can be ignored):', error);
      }
    }
  }

  startVoiceInput() {
    if (this.isProcessing) return;
    if (!this.isRecording) {
      // Resume AudioContext on user interaction
      this.resumeAudioContextIfNeeded();
      
      // Stop wake word listener to prevent duplicate processing
      console.log('[ChatWidget] 🛑 Stopping wake word listener before starting voice input');
      this.voiceWakeup.stopListening();
      
      // Reset auto-close timer when voice input starts
      this.resetAutoCloseTimer();
      this.isRecording = true;
      console.log('[ChatWidget] 🎤 Starting Azure Speech recognition...');
      
      const started = this.azureSpeechService.startContinuousRecognition();
      if (!started) {
        console.error('[ChatWidget] ❌ Failed to start Azure Speech recognition');
        this.isRecording = false;
        this.showErrorMessage('Failed to start voice recognition. Please check your Azure configuration.');
        // Restart wake word listener if recognition failed
        this.startWakeWordListener();
      }
    }
  }

  stopVoiceInput() {
    if (this.isRecording) {
      console.log('[ChatWidget] 🛑 Stopping Azure Speech recognition...');
      this.isRecording = false;
      this.azureSpeechService.stopContinuousRecognition()
        .catch(error => {
          console.error('[ChatWidget] ❌ Error stopping recognition:', error);
        });
    }
  }

  /**
   * Pause voice recognition (for modal usage)
   */
  pauseVoiceRecognition(): void {
    console.log('[ChatWidget] Pausing voice recognition for modal...');
    this.stopVoiceInput();
    // Stop wake word listener too
    this.voiceWakeup.stopListening();
  }

  /**
   * Resume voice recognition (after modal closes)
   */
  resumeVoiceRecognition(): void {
    console.log('[ChatWidget] Resuming voice recognition after modal...');
    // Restart wake word listener
    this.startWakeWordListener();
  }

  // toggleVoiceInput() {
  //   if (this.isProcessing) return;

  //   if (this.isListening || this.isRecording) {
  //     this.stopVoiceInput();
  //   } else {
  //     this.startVoiceInput();
  //   }
  // }
  toggleVoiceInput() {
    if (this.isProcessing) return;
    if (this.isRecording) {
      this.stopVoiceInput();
    } else {
      this.startVoiceInput();
    }
  }

  toggleChat() {
    console.log('[ChatWidget] toggleChat called. Current state:', this.isChatOpen, '-> New state:', !this.isChatOpen);
    
    // Resume AudioContext on user interaction to comply with browser policies
    this.resumeAudioContextIfNeeded();
    
    this.isChatOpen = !this.isChatOpen;

    if (this.autoOpenTimer) {
      clearTimeout(this.autoOpenTimer);
      this.autoOpenTimer = null;
    }

    if (this.isChatOpen) {
      setTimeout(() => this.scrollToBottom(), 100);
      this.resetAutoCloseTimer(); // Start auto-close timer when chat opens
    } else {
      this.clearAutoCloseTimer();
      // Stop wake word listener first, then restart it
      console.log('[ChatWidget] Chat closed, restarting wake word listener...');
      this.voiceWakeup.stopListening();
      setTimeout(() => {
        this.startWakeWordListener();
      }, 700); // Wait for stop to complete before starting again
    }
  }

  /**
   * Reset the auto-close timer - called when user interacts with chat
   */
  private resetAutoCloseTimer(): void {
    this.clearAutoCloseTimer();
    
    console.log('[ChatWidget] Starting auto-close timer (30 seconds)');
    this.autoCloseTimer = setTimeout(() => {
      // Don't close if any activity is in progress
      const hasActivity = this.isRecording || 
                         this.isProcessing || 
                         this.isUserTyping || 
                         this.isVoicePlaying || 
                         this.isFeedbackInProgress;
      
      if (this.isChatOpen && !hasActivity) {
        console.log('[ChatWidget] Auto-closing due to inactivity');
        this.isChatOpen = false;
        this.startWakeWordListener();
      } else if (hasActivity) {
        console.log('[ChatWidget] Activity detected, resetting timer');
        this.resetAutoCloseTimer(); // Reset timer if activity is in progress
      }
    }, this.AUTO_CLOSE_DELAY);
  }

  /**
   * Clear the auto-close timer
   */
  private clearAutoCloseTimer(): void {
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
      this.autoCloseTimer = null;
    }
  }

  private startWakeWordListener(): void {
    console.log('[ChatWidget] 🎧 Starting wake word listener...');
    
    try {
      this.voiceWakeup.startListening(
        () => {
          // Wake word callback
          console.log('[ChatWidget] 👂 *** WAKE WORD "hey buddy" DETECTED ***');
          
          // Don't process if Azure Speech is already recording
          if (this.isRecording) {
            console.log('[ChatWidget] ⚠️ Ignoring wake word - Azure Speech is active');
            return;
          }
          
          this.voiceWakeup.stopListening();

          if (!this.isChatOpen) {
            // Case 1: Chat is closed. Open it AND start voice input.
            console.log('[ChatWidget] Chat is closed. Opening and starting voice input...');
            this.toggleChat();
            setTimeout(() => this.toggleVoiceInput(), 300); // Keep delay for mic handover
          } else {
            // Case 2: Chat is already open. Just start the voice input.
            console.log('[ChatWidget] Chat is open. Starting voice input directly...');
            this.toggleVoiceInput();
          }
        },
        async (transcript: string) => {
          // Work order command callback
          console.log('[ChatWidget] 📋 Work order command detected via wake word listener:', transcript);
          
          // Don't process if Azure Speech is already recording
          if (this.isRecording) {
            console.log('[ChatWidget] ⚠️ Ignoring work order command - Azure Speech is active');
            return;
          }
          
          this.voiceWakeup.stopListening();

          // Open chat if closed
          if (!this.isChatOpen) {
            this.toggleChat();
          }

          // Add user message with voice indicator
          // Note: For wake word detected commands, we need to add the message here
          // because sendTranscriptToAPI will handle navigation commands specially
          this.messages.push({
            text: transcript,
            sender: 'user',
            avatar: '🧑',
            isVoice: true
          });

          this.cdr.detectChanges();
          this.scrollToBottom();

          // Send to API and get response (mark as voice input from wake word)
          // Pass userMessageAlreadyAdded=true since we just added it above
          await this.sendTranscriptToAPI(transcript, true, true);
        }
      );
    } catch (error) {
      console.error('[ChatWidget] ❌ Failed to start wake word listener:', error);
      // This is expected if AudioContext is not allowed yet
      // The listener will start properly after user interaction (e.g., clicking voice button)
    }
  }

  minimizeChat() {
    this.isChatOpen = false;
  }

  handleEnterKey(event: KeyboardEvent) {
    if (!event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  adjustTextareaHeight(event: any) {
    const textarea = event.target;
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
  }

  getVoiceButtonClass(): string {
    let baseClass = 'p-button-rounded voice-btn';
    if (this.isRecording) {
      baseClass += ' recording-active';
    }
    return baseClass;
  }

  getVoiceTooltip(): string {
    if (this.isRecording) {
      return 'Stop recording';
    } else if (this.isProcessing) {
      return 'Processing...';
    } else {
      return 'Start voice input';
    }
  }

  sendQuickMessage(message: string) {
    this.userInput = message;
    this.sendMessage();
  }

  getCurrentTime(): string {
    return new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
  }

  private scrollToBottom() {
    setTimeout(() => {
      const messagesContainer = document.querySelector('.chat-messages');
      if (messagesContainer) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }, 50);
  }

  async sendMessage() {
    this.isRecording = false;

    if (!this.userInput.trim() || this.isProcessing) return;

    // User sent message, no longer typing
    this.isUserTyping = false;

    // Reset auto-close timer on user interaction
    this.resetAutoCloseTimer();

    const messageText = this.userInput.trim();
    this.userInput = '';

    // Add user message (text input, not voice)
    this.messages.push({
      text: messageText,
      sender: 'user',
      avatar: '🧑',
      isVoice: false
    });

    this.cdr.detectChanges(); // Force immediate UI update
    this.scrollToBottom();

    // Send to API and get response (not voice input)
    // Pass userMessageAlreadyAdded=true since we just added it above
    await this.sendTranscriptToAPI(messageText, false, true);
  }

  // ngOnDestroy() {
  //   // Clean up the auto-open timer when component is destroyed
  //   if (this.autoOpenTimer) {
  //     clearTimeout(this.autoOpenTimer);
  //     this.autoOpenTimer = null;
  //   }
  // }
  ngOnDestroy() {
    console.log('[ChatWidget] Component destroyed. Cleaning up resources...');
    if (this.autoOpenTimer) {
      clearTimeout(this.autoOpenTimer);
    }
    if (this.autoCloseTimer) {
      clearTimeout(this.autoCloseTimer);
    }
    if (this.messageSubscription) {
      this.messageSubscription.unsubscribe();
    }
    
    // Clean up Azure Speech subscriptions
    if (this.azureSpeechResultSubscription) {
      this.azureSpeechResultSubscription.unsubscribe();
    }
    if (this.azureSpeechErrorSubscription) {
      this.azureSpeechErrorSubscription.unsubscribe();
    }
    if (this.azureSpeechEndSubscription) {
      this.azureSpeechEndSubscription.unsubscribe();
    }
    
    // Stop Azure Speech recognition
    if (this.azureSpeechService.isActive()) {
      this.azureSpeechService.stopContinuousRecognition();
    }
    
    this.voiceWakeup.stopListening();
  }

  /**
   * Handle input focus - user is typing
   */
  onInputFocus(): void {
    console.log('[ChatWidget] User started typing');
    this.isUserTyping = true;
    this.clearAutoCloseTimer(); // Stop timer while typing
  }

  /**
   * Handle input blur - user stopped typing
   */
  onInputBlur(): void {
    console.log('[ChatWidget] User stopped typing');
    this.isUserTyping = false;
    // Only restart timer if input is empty
    if (!this.userInput.trim()) {
      this.resetAutoCloseTimer();
    }
  }

  /**
   * Handle input change - track typing activity
   */
  onInputChange(): void {
    // If user clears the input while typing, restart timer
    if (!this.userInput.trim() && !this.isUserTyping) {
      this.resetAutoCloseTimer();
    }
  }
  
  /**
   * Submit feedback for a bot message
   */
  submitFeedback(message: any, isPositive: boolean): void {
    if (!message.sessionId || message.stepNumber === undefined) {
      console.warn('[ChatWidget] Cannot submit feedback - missing session or step info');
      return;
    }

    const feedback = isPositive ? 'positive' : 'negative';
    
    console.log('[ChatWidget] Submitting feedback:', {
      sessionId: message.sessionId,
      stepNumber: message.stepNumber,
      feedback: feedback
    });

    this.isFeedbackInProgress = true;

    this.feedbackService.submitFeedback(
      message.sessionId,
      message.stepNumber,
      feedback,
      '' // No notes for now
    ).subscribe({
      next: (response) => {
        console.log('[ChatWidget] Feedback submitted successfully:', response);
        
        // Update message feedback state
        message.feedback = feedback;
        this.cdr.detectChanges();

        // Check if there's a next step to display
        // Don't await here - handle async operations inside the handlers
        if (response.type === 'next_step' && response.message) {
          // Call without await to avoid blocking
          this.handleNextStepResponse(response).catch(error => {
            console.error('[ChatWidget] Error handling next step:', error);
          });
        } else if (response.type === 'work_order_complete') {
          // Call without await to avoid blocking
          this.handleWorkOrderComplete(response).catch(error => {
            console.error('[ChatWidget] Error handling completion:', error);
          });
        } else {
          // No next step, just mark as complete
          this.isFeedbackInProgress = false;
        }
      },
      error: (error) => {
        console.error('[ChatWidget] Failed to submit feedback:', error);
        alert('Failed to submit feedback. Please try again.');
        this.isFeedbackInProgress = false;
      }
    });
  }

  /**
   * Handle next step response after feedback
   */
  private async handleNextStepResponse(response: any): Promise<void> {
    // Store completed step for UI update
    if (response.progress?.completed) {
      sessionStorage.setItem('completed_step', response.progress.completed.toString());
    }

    // Increment step number for the new message
    this.currentStepNumber++;

    // Format the response message
    let responseMessage = response.message;
    
    // Add tts_text if available
    if (response.tts_text) {
      responseMessage += `\n\n${response.tts_text}`;
    }

    // Add estimated time if available
    if (response.current_step?.estimated_time) {
      responseMessage += `\n\nEstimated time: ${response.current_step.estimated_time} hours`;
    }

    // Add progress info
    if (response.progress) {
      responseMessage += `\n\nProgress: ${response.progress.completed}/${response.progress.total} steps (${response.progress.percentage.toFixed(1)}%)`;
    }

    // Add new bot message with the next step
    this.messages.push({
      text: responseMessage,
      sender: 'bot',
      avatar: '🤖',
      isVoice: true,
      sessionId: this.currentSessionId,
      stepNumber: this.currentStepNumber,
      feedback: null
    });

    this.cdr.detectChanges();
    this.scrollToBottom();

    // Speak the response
    try {
      this.isVoicePlaying = true;
      await this.voiceApiService.speakText(responseMessage);
      this.isVoicePlaying = false;
      // Notify that voice synthesis is complete for step marking
      this.chatService.notifyVoiceComplete();
    } catch (error) {
      console.error('[ChatWidget] Error with text-to-speech:', error);
      this.isVoicePlaying = false;
    } finally {
      // Mark feedback as complete after voice finishes
      this.isFeedbackInProgress = false;
    }
  }

  /**
   * Handle work order completion
   */
  private async handleWorkOrderComplete(response: any): Promise<void> {
    // Work order completed
    sessionStorage.setItem('work_order_complete', 'true');
    
    this.messages.push({
      text: response.message || 'Work order completed successfully! 🎉',
      sender: 'bot',
      avatar: '🤖',
      isVoice: true,
      sessionId: this.currentSessionId,
      stepNumber: this.currentStepNumber,
      feedback: null
    });

    this.cdr.detectChanges();
    this.scrollToBottom();

    try {
      this.isVoicePlaying = true;
      await this.voiceApiService.speakText(response.message || 'Work order completed successfully!');
      this.isVoicePlaying = false;
      this.chatService.notifyVoiceComplete();
    } catch (error) {
      console.error('[ChatWidget] Error with text-to-speech:', error);
      this.isVoicePlaying = false;
    } finally {
      // Mark feedback as complete after voice finishes
      this.isFeedbackInProgress = false;
    }
  }
}
