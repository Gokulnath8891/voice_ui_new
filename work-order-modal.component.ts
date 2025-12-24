import { Component, OnInit, OnDestroy, ChangeDetectorRef, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { DialogModule } from 'primeng/dialog';
import { ButtonModule } from 'primeng/button';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { AvatarModule } from 'primeng/avatar';
import { TooltipModule } from 'primeng/tooltip';
import { WorkOrderService } from '../services/work-order.service';
import { FeedbackService } from '../services/feedback.service';
import { VoiceApiService } from '../chat-widget/voice-api.service';
import { WakeupVoiceService } from '../chat-widget/wakeup-voice.service';
import { AzureSpeechService } from '../services/azure-speech.service';
import { Subscription } from 'rxjs';

interface Message {
  text: string;
  sender: 'user' | 'bot';
  avatar: string;
  isVoice?: boolean;
  stepNumber?: number;
  sessionId?: string;
  feedback?: 'positive' | 'negative' | null;
}

@Component({
  selector: 'app-work-order-modal',
  standalone: true,
  imports: [
    CommonModule,
    FormsModule,
    DialogModule,
    ButtonModule,
    InputTextareaModule,
    AvatarModule,
    TooltipModule
  ],
  templateUrl: './work-order-modal.component.html',
  styleUrls: ['./work-order-modal.component.scss']
})
export class WorkOrderModalComponent implements OnInit, OnDestroy {
  @ViewChild('messagesContainer') private messagesContainer?: ElementRef;

  private _visible = false;
  
  get visible(): boolean {
    return this._visible;
  }
  
  set visible(value: boolean) {
    const wasVisible = this._visible;
    this._visible = value;
    
    // If modal is being closed (was visible, now not visible)
    if (wasVisible && !value) {
      this.handleClose();
    }
  }
  
  workOrderNumber = '';
  workOrderId = 0; // Numeric ID for work order
  userInput = '';
  messages: Message[] = [];
  
  isRecording = false;
  isProcessing = false;
  isVoicePlaying = false;
  isFeedbackInProgress = false;
  isResumedWorkOrder = false; // Track if this is a resumed work order
  
  private recognition: any = null;
  private currentSessionId = '';
  private currentStepNumber = 0;
  private currentStepId = 0; // Store the step ID for feedback API
  private chatWidgetRef: any = null; // Reference to chat widget for voice control
  private onCloseCallback?: () => void; // Callback to execute when modal closes
  private azureSpeechResultSubscription: Subscription | null = null;
  private azureSpeechErrorSubscription: Subscription | null = null;
  private azureSpeechEndSubscription: Subscription | null = null;
  
  // Duplicate detection
  private lastProcessedMessage = '';
  private lastProcessedTime = 0;
  private readonly DUPLICATE_THRESHOLD_MS = 2000; // 2 seconds
  private isProcessingMessage = false; // Flag to prevent concurrent processing
  private pendingFeedback = new Set<string>(); // Track pending feedback requests
  
  // Static global locks to prevent ANY duplicate API calls across all instances
  private static activeApiCalls = new Map<string, Promise<any>>();

  constructor(
    private readonly workOrderService: WorkOrderService,
    private readonly feedbackService: FeedbackService,
    private readonly voiceApiService: VoiceApiService,
    private readonly wakeupVoiceService: WakeupVoiceService,
    private readonly cdr: ChangeDetectorRef,
    private readonly azureSpeechService: AzureSpeechService
  ) {}

  ngOnInit() {
    this.initializeAzureSpeech();
  }

  ngOnDestroy() {
    console.log('[WorkOrderModal] Component destroyed. Cleaning up resources...');
    
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
    
    // Stop old recognition if any
    if (this.recognition) {
      this.recognition.stop();
    }
  }

  /**
   * Open modal with work order number
   */
  async open(
    workOrderNumber: string, 
    chatWidget?: any, 
    action: 'start' | 'resume' | 'restart' = 'start',
    onClose?: () => void
  ): Promise<void> {
    console.log('[WorkOrderModal] 🚀 OPENING MODAL');
    console.log('[WorkOrderModal] 📋 Work Order:', workOrderNumber);
    console.log('[WorkOrderModal] 🎬 Action:', action);
    console.log('[WorkOrderModal] 🔗 Has Callback:', !!onClose);
    
    this.workOrderNumber = workOrderNumber;
    this.chatWidgetRef = chatWidget;
    this.onCloseCallback = onClose; // Store the callback
    this.visible = true;
    this.messages = [];
    this.currentStepNumber = 0;
    
    // Stop chat widget voice recognition and wake word listener
    if (this.chatWidgetRef?.pauseVoiceRecognition) {
      this.chatWidgetRef.pauseVoiceRecognition();
    }
    
    // Force change detection
    this.cdr.detectChanges();
    
    console.log('[WorkOrderModal] ✅ Modal visible set to:', this.visible);
    console.log('[WorkOrderModal] 🔄 Calling action method:', action);
    
    // Call appropriate method based on action
    try {
      switch (action) {
        case 'resume':
          console.log('[WorkOrderModal] 📞 Calling resumeWorkOrder()...');
          await this.resumeWorkOrder();
          break;
        case 'restart':
          console.log('[WorkOrderModal] 📞 Calling restartWorkOrder()...');
          await this.restartWorkOrder();
          break;
        case 'start':
        default:
          console.log('[WorkOrderModal] 📞 Calling startWorkOrder()...');
          await this.startWorkOrder();
          break;
      }
      console.log('[WorkOrderModal] ✅ Action method completed');
    } catch (error) {
      console.error('[WorkOrderModal] ❌ Error in action method:', error);
    }
    
    // Start modal's wake word listener after work order action completes
    // This ensures the modal is fully initialized and ready
    setTimeout(() => {
      console.log('[WorkOrderModal] 🎤 Starting wake word listener...');
      this.startModalWakeWordListener();
    }, 1000);
  }

  /**
   * Handle modal close - called automatically when visible changes to false
   */
  private handleClose(): void {
    // Stop any ongoing speech immediately
    if ('speechSynthesis' in globalThis) {
      speechSynthesis.cancel();
    }
    
    // Stop speech recognition immediately
    if (this.recognition) {
      this.recognition.stop();
    }
    
    // Stop wake word listener immediately
    this.wakeupVoiceService.stopListening();
    
    // Reset UI state immediately
    this.isRecording = false;
    this.isProcessing = false;
    this.isVoicePlaying = false;
    this.isFeedbackInProgress = false;
    
    // Call onClose callback if provided (e.g., to reload work orders)
    if (this.onCloseCallback) {
      this.onCloseCallback();
      this.onCloseCallback = undefined; // Clear the callback
    }
    
    // Cleanup asynchronously to not block the UI
    setTimeout(() => {
      this.messages = [];
      this.currentSessionId = '';
      this.currentStepNumber = 0;
      this.currentStepId = 0;
      this.isResumedWorkOrder = false;
      
      sessionStorage.removeItem('current_session_id');
      sessionStorage.removeItem('current_work_order');
      sessionStorage.removeItem('completed_step');
      
      // Resume chat widget voice recognition and wake word listener
      if (this.chatWidgetRef?.resumeVoiceRecognition) {
        this.chatWidgetRef.resumeVoiceRecognition();
      }
      
      // Clear chat widget reference
      this.chatWidgetRef = null;
    }, 0);
  }
  
  /**
   * Close modal - public method that can be called programmatically
   */
  close(): void {
    this.visible = false; // This will trigger handleClose via the setter
  }

  /**
   * Start work order
   */
  private async startWorkOrder(): Promise<void> {
    try {
      this.isProcessing = true;
      this.cdr.detectChanges(); // Force UI update
      
      const userId = 1; // TODO: Get from AuthService
      const response = await this.workOrderService.startWork(this.workOrderNumber, userId);
      
      if (response.type === 'error') {
        this.addMessage('Error starting work order: ' + response.message, 'bot');
        return;
      }
      
      if (response.type === 'work_order_start') {
        // Store session info
        if (response.session_id) {
          this.currentSessionId = response.session_id;
          sessionStorage.setItem('current_session_id', response.session_id);
        }
        
        // Format message
        let messageText = `Starting work order ${this.workOrderNumber}.`;
        
        if (response.tts_text) {
          messageText += `\n\n${response.tts_text}`;
        }
        
        if (response.current_step?.estimated_time) {
          messageText += `\n\nEstimated time: ${response.current_step.estimated_time} hours`;
        }
        
        this.currentStepNumber++;
        
        this.messages.push({
          text: messageText,
          sender: 'bot',
          avatar: '🤖',
          isVoice: true,
          sessionId: this.currentSessionId,
          stepNumber: this.currentStepNumber,
          feedback: null
        });
        
        this.cdr.detectChanges(); // Force UI update to show message
        this.scrollToBottom();
        
        // Speak response
        await this.speakText(messageText);
      }
    } catch (error) {
      console.error('Error starting work order:', error);
      this.addMessage('Failed to start work order. Please try again.', 'bot');
    } finally {
      this.isProcessing = false;
      this.cdr.detectChanges(); // Force UI update to enable inputs
    }
  }

  /**
   * Resume work order from first incomplete step
   */
  private async resumeWorkOrder(): Promise<void> {
    try {
      this.isProcessing = true;
      this.cdr.detectChanges(); // Force UI update
      
      const response = await this.workOrderService.resumeWorkOrder(this.workOrderNumber);
      
      if (response.type === 'error') {
        this.addMessage('Error resuming work order: ' + response.message, 'bot');
        return;
      }
      
      if (response.type === 'work_order_start') {
        // Mark this as a resumed work order
        this.isResumedWorkOrder = true;
        
        // Store session info
        if (response.session_id) {
          this.currentSessionId = response.session_id;
          sessionStorage.setItem('current_session_id', response.session_id);
        }
        
        // Store work order ID and current step info
        if (response.work_order?.id) {
          this.workOrderId = response.work_order.id;
        }
        
        if (response.current_step?.id) {
          this.currentStepId = response.current_step.id;
        }
        
        // Format message - show message once, then current step description
        let messageText = response.message || `Resuming work order ${this.workOrderNumber}.`;
        
        // Add current step description instead of repeating the message
        if (response.current_step?.description) {
          messageText += `\n\n${response.current_step.description}`;
        }
        
        if (response.current_step?.estimated_time) {
          messageText += `\n\nEstimated time: ${response.current_step.estimated_time} hours`;
        }
        
        // Set current step number from response
        this.currentStepNumber = response.current_step?.step_number || 1;
        
        this.messages.push({
          text: messageText,
          sender: 'bot',
          avatar: '🤖',
          isVoice: true,
          sessionId: this.currentSessionId,
          stepNumber: this.currentStepNumber,
          feedback: null
        });
        
        this.cdr.detectChanges(); // Force UI update to show message
        this.scrollToBottom();
        
        // Speak response
        await this.speakText(messageText);
      }
    } catch (error) {
      console.error('Error resuming work order:', error);
      this.addMessage('Failed to resume work order. Please try again.', 'bot');
    } finally {
      this.isProcessing = false;
      this.cdr.detectChanges(); // Force UI update to enable inputs
    }
  }

  /**
   * Restart work order from the beginning (reset all progress)
   */
  private async restartWorkOrder(): Promise<void> {
    try {
      this.isProcessing = true;
      this.cdr.detectChanges(); // Force UI update
      
      const response = await this.workOrderService.restartWorkOrder(this.workOrderNumber);
      
      if (response.type === 'error') {
        this.addMessage('Error restarting work order: ' + response.message, 'bot');
        return;
      }
      
      if (response.type === 'work_order_start') {
        // Store session info
        if (response.session_id) {
          this.currentSessionId = response.session_id;
          sessionStorage.setItem('current_session_id', response.session_id);
        }
        
        // Format message
        let messageText = `Restarting work order ${this.workOrderNumber} from the beginning.`;
        
        if (response.tts_text) {
          messageText += `\n\n${response.tts_text}`;
        }
        
        if (response.current_step?.estimated_time) {
          messageText += `\n\nEstimated time: ${response.current_step.estimated_time} hours`;
        }
        
        this.currentStepNumber = 1; // Always start from step 1
        
        this.messages.push({
          text: messageText,
          sender: 'bot',
          avatar: '🤖',
          isVoice: true,
          sessionId: this.currentSessionId,
          stepNumber: this.currentStepNumber,
          feedback: null
        });
        
        this.cdr.detectChanges(); // Force UI update to show message
        this.scrollToBottom();
        
        // Speak response
        await this.speakText(messageText);
      }
    } catch (error) {
      console.error('Error restarting work order:', error);
      this.addMessage('Failed to restart work order. Please try again.', 'bot');
    } finally {
      this.isProcessing = false;
      this.cdr.detectChanges(); // Force UI update to enable inputs
    }
  }

  /**
   * Initialize Azure Speech Service
   */
  private initializeAzureSpeech(): void {
    console.log('[WorkOrderModal] 🎤 Initializing Azure Speech Service');
    
    // Unsubscribe from any existing subscriptions to prevent duplicates
    if (this.azureSpeechResultSubscription) {
      console.warn('[WorkOrderModal] ⚠️ Found existing Azure Speech result subscription - unsubscribing');
      this.azureSpeechResultSubscription.unsubscribe();
      this.azureSpeechResultSubscription = null;
    }
    
    if (this.azureSpeechErrorSubscription) {
      console.warn('[WorkOrderModal] ⚠️ Found existing Azure Speech error subscription - unsubscribing');
      this.azureSpeechErrorSubscription.unsubscribe();
      this.azureSpeechErrorSubscription = null;
    }
    
    if (this.azureSpeechEndSubscription) {
      console.warn('[WorkOrderModal] ⚠️ Found existing Azure Speech end subscription - unsubscribing');
      this.azureSpeechEndSubscription.unsubscribe();
      this.azureSpeechEndSubscription = null;
    }
    
    // Subscribe to recognition results
    this.azureSpeechResultSubscription = this.azureSpeechService.onResult$.subscribe(
      (result) => {
        console.log(`[WorkOrderModal] ${result.isFinal ? '✅ Final' : '🎤 Interim'} result:`, result.transcript);
        
        // Only process final results
        if (result.isFinal && result.transcript.trim()) {
          const finalTranscript = result.transcript.trim();
          
          // Stop recognition to process this result
          this.isRecording = false;
          this.azureSpeechService.stopContinuousRecognition();
          
          // Set the user input and auto-send
          this.userInput = finalTranscript;
          this.cdr.detectChanges();
          
          // Auto-send the message
          this.sendMessage();
          
          // Restart wake word listener after processing
          setTimeout(() => this.startModalWakeWordListener(), 500);
        }
      }
    );

    // Subscribe to recognition errors
    this.azureSpeechErrorSubscription = this.azureSpeechService.onError$.subscribe(
      (error) => {
        console.error('[WorkOrderModal] ❌ Azure Speech error:', error);
        this.isRecording = false;
        this.cdr.detectChanges();
        
        // Restart wake word listener after error
        setTimeout(() => this.startModalWakeWordListener(), 500);
      }
    );

    // Subscribe to recognition end events
    this.azureSpeechEndSubscription = this.azureSpeechService.onEnd$.subscribe(
      () => {
        console.log('[WorkOrderModal] 🛑 Azure Speech recognition ended');
        this.isRecording = false;
        this.cdr.detectChanges();
        
        // Restart wake word listener after voice input ends
        setTimeout(() => this.startModalWakeWordListener(), 500);
      }
    );
  }

  /**
   * Toggle voice input
   */
  toggleVoiceInput(): void {
    if (this.isRecording) {
      this.azureSpeechService.stopContinuousRecognition();
      this.isRecording = false;
    } else {
      const started = this.azureSpeechService.startContinuousRecognition();
      this.isRecording = started;
      if (!started) {
        console.error('[WorkOrderModal] ❌ Failed to start Azure Speech recognition');
      }
    }
    this.cdr.detectChanges();
  }

  /**
   * Send message
   */
  async sendMessage(): Promise<void> {
    if (!this.userInput.trim() || this.isProcessing || this.isProcessingMessage) {
      console.log('[WorkOrderModal] ⚠️ Skipping sendMessage - already processing or empty input');
      return;
    }

    const messageText = this.userInput.trim();
    
    // Prevent duplicate processing of the same message within a short time window
    const now = Date.now();
    const timeSinceLastProcess = now - this.lastProcessedTime;
    const isSameMessage = this.lastProcessedMessage.toLowerCase().trim() === messageText.toLowerCase().trim();
    
    if (isSameMessage && timeSinceLastProcess < this.DUPLICATE_THRESHOLD_MS) {
      console.warn('[WorkOrderModal] ⚠️ DUPLICATE MESSAGE DETECTED - Ignoring:', {
        message: messageText,
        timeSinceLastProcess: `${timeSinceLastProcess}ms`,
        threshold: `${this.DUPLICATE_THRESHOLD_MS}ms`
      });
      this.userInput = ''; // Clear input even for duplicate
      return;
    }
    
    // Set processing flag IMMEDIATELY to block concurrent calls
    this.isProcessingMessage = true;
    
    // Update tracking
    this.lastProcessedMessage = messageText;
    this.lastProcessedTime = now;
    
    this.userInput = '';

    // Add user message
    this.addMessage(messageText, 'user', false);

    try {
      // Check if it's a "proceed" command
      const nextStepPattern = /(?:proceed|continue|next|move\s+to\s+next|completed?)\s+(?:step|to\s+step)?/i;
      
      if (nextStepPattern.test(messageText) && this.currentSessionId) {
        await this.proceedToNextStep(messageText);
      } else {
        // Send as regular query to chat API
        await this.sendQueryToAPI(messageText);
      }
    } finally {
      // Always clear the processing flag
      this.isProcessingMessage = false;
    }
  }

  /**
   * Send general query to API
   */
  private async sendQueryToAPI(query: string): Promise<void> {
    const callKey = `query-${query.toLowerCase().trim()}`;
    
    // Check if this exact call is already in progress globally
    if (WorkOrderModalComponent.activeApiCalls.has(callKey)) {
      console.warn('[WorkOrderModal] ⛔ DUPLICATE QUERY API CALL BLOCKED - Already in progress:', query);
      return;
    }
    
    try {
      this.isProcessing = true;
      this.cdr.detectChanges();

      // Create the API call promise and store it
      const apiPromise = this.voiceApiService.sendTextToAPI(query, false);
      WorkOrderModalComponent.activeApiCalls.set(callKey, apiPromise);
      
      // Get response from chat API
      const botResponse = await apiPromise;

      // DON'T increment stepNumber here - this is not a tracked workflow step
      // Only work order start/proceed responses should have step numbers for feedback

      // Add bot response WITHOUT step number since this is just a query, not a workflow step
      this.messages.push({
        text: botResponse,
        sender: 'bot',
        avatar: '🤖',
        isVoice: true,
        sessionId: this.currentSessionId,
        stepNumber: undefined, // No step number for general queries
        feedback: null
      });

      this.cdr.detectChanges();
      this.scrollToBottom();

      // Speak the response
      await this.speakText(botResponse);

      this.isProcessing = false;
      this.cdr.detectChanges();
    } catch (error) {
      console.error('[WorkOrderModal] Query API error:', error);
      this.addMessage('Failed to get response. Please try again.', 'bot');
      this.isProcessing = false;
      this.cdr.detectChanges();
      
      // Restart wake word listener even on error
      setTimeout(() => this.startModalWakeWordListener(), 500);
    } finally {
      // Always clean up the active call
      WorkOrderModalComponent.activeApiCalls.delete(callKey);
    }
  }

  /**
   * Proceed to next step using feedback API
   */
  private async proceedToNextStep(userInput: string): Promise<void> {
    // Prevent duplicate proceed calls
    if (this.isProcessing || this.isFeedbackInProgress) {
      console.warn('[WorkOrderModal] ⚠️ DUPLICATE PROCEED - Already processing');
      return;
    }
    
    // Check if we have a pending feedback request for this step
    const proceedKey = `proceed-${this.currentSessionId}-${this.currentStepNumber}`;
    if (this.pendingFeedback.has(proceedKey)) {
      console.warn('[WorkOrderModal] ⚠️ DUPLICATE PROCEED REQUEST - Already in progress:', proceedKey);
      return;
    }
    
    // Global lock to prevent duplicate across all instances
    const globalKey = `feedback-${this.currentSessionId}-${this.currentStepNumber}`;
    if (WorkOrderModalComponent.activeApiCalls.has(globalKey)) {
      console.error('[WorkOrderModal] ⛔ DUPLICATE FEEDBACK API CALL BLOCKED GLOBALLY:', globalKey);
      return;
    }
    
    try {
      this.isProcessing = true;
      this.isFeedbackInProgress = true;
      this.pendingFeedback.add(proceedKey);
      
      const userId = 1; // TODO: Get from AuthService
      
      // Use different endpoint based on whether work order was resumed
      const feedbackObservable = this.isResumedWorkOrder && this.currentStepId
        ? this.feedbackService.submitWorkOrderFeedback(
            this.workOrderId,
            this.currentStepId,
            `positive - ${userInput}`,
            0.5 // TODO: Track actual time spent
          )
        : this.feedbackService.submitFeedback(
            this.currentSessionId,
            this.currentStepNumber,
            'positive',
            userInput,
            userId
          );
      
      // Convert observable to promise and store in global lock
      const feedbackPromise = feedbackObservable.toPromise();
      WorkOrderModalComponent.activeApiCalls.set(globalKey, feedbackPromise);
      
      feedbackObservable.subscribe({
        next: async (response) => {
          console.log('[WorkOrderModal] Next step response:', response);
          
          // Clean up global lock on success
          WorkOrderModalComponent.activeApiCalls.delete(globalKey);
          
          // Update step ID if provided (for resumed work orders)
          // Use next_step for resumed work orders, current_step for chat-started
          const stepToUpdate = this.isResumedWorkOrder && response.next_step 
            ? response.next_step 
            : response.current_step;
            
          if (stepToUpdate && 'id' in stepToUpdate && stepToUpdate.id) {
            this.currentStepId = stepToUpdate.id as number;
          }
          
          // Handle both "complete" and "work_order_complete" types
          if (response.type === 'complete' || response.type === 'work_order_complete') {
            sessionStorage.setItem('work_order_complete', 'true');
            
            // Format completion message
            let completionMessage = response.message || 'Work order completed successfully! 🎉';
            
            // Add summary information if available (using any to handle dynamic API response)
            const responseData = response as any;
            if (responseData.summary) {
              completionMessage += '\n\n📊 Work Order Summary:';
              
              if (responseData.summary.summary_text) {
                completionMessage += `\n${responseData.summary.summary_text}`;
              }
              
              if (responseData.summary.major_issues_resolved) {
                completionMessage += `\n\n🔧 Major Issues Resolved:\n${responseData.summary.major_issues_resolved}`;
              }
              
              if (responseData.summary.recommendations_for_customer) {
                completionMessage += `\n\n💡 Recommendations:\n${responseData.summary.recommendations_for_customer}`;
              }
            } else {
              // Fallback to individual fields if summary object not available
              if (response.total_steps) {
                completionMessage += `\n\n✅ Total Steps Completed: ${response.total_steps}`;
              }
              if (response.total_time) {
                const hours = typeof response.total_time === 'string' 
                  ? Number.parseFloat(response.total_time).toFixed(2)
                  : response.total_time.toFixed(2);
                completionMessage += `\n⏱️ Total Time: ${hours} hours`;
              }
            }
            
            this.addMessage(completionMessage, 'bot', true);
            
            // Create voice output with summary
            let speechText = response.message || 'Work order completed successfully!';
            
            if (responseData.summary?.summary_text) {
              speechText += ` ${responseData.summary.summary_text}`;
              
              if (responseData.summary.major_issues_resolved) {
                speechText += ` Major issues resolved: ${responseData.summary.major_issues_resolved}`;
              }
              
              if (responseData.summary.recommendations_for_customer) {
                speechText += ` Recommendations for customer: ${responseData.summary.recommendations_for_customer}`;
              }
            } else if (response.tts_text) {
              speechText = response.tts_text;
            }
            
            await this.speakText(speechText);
            
            this.isFeedbackInProgress = false;
            this.isProcessing = false;
            return;
          }

          if (response.type === 'next_step') {
            // Store completed step
            if (response.progress?.completed) {
              sessionStorage.setItem('completed_step', response.progress.completed.toString());
            } else if (response.completed_steps) {
              // For work order feedback endpoint
              sessionStorage.setItem('completed_step', response.completed_steps.toString());
            }

            this.currentStepNumber++;

            // Format message differently based on endpoint used
            let messageText = response.message || 'Proceeding to next step.';
            
            // For resumed work orders, use next_step.description
            if (this.isResumedWorkOrder && response.next_step?.description) {
              messageText += `\n\n${response.next_step.description}`;
              
              if (response.next_step.estimated_time) {
                messageText += `\n\nEstimated time: ${response.next_step.estimated_time} hours`;
              }
            } else {
              // For chat-started work orders, use existing logic
              if (response.tts_text) {
                messageText += `\n\n${response.tts_text}`;
              }
              
              if (response.current_step?.estimated_time) {
                messageText += `\n\nEstimated time: ${response.current_step.estimated_time} hours`;
              }
            }

            if (response.progress) {
              messageText += `\n\nProgress: ${response.progress.completed}/${response.progress.total} steps (${response.progress.percentage.toFixed(1)}%)`;
            } else if (response.completed_steps && response.total_steps) {
              // For work order feedback endpoint
              const percentage = (response.completed_steps / response.total_steps) * 100;
              messageText += `\n\nProgress: ${response.completed_steps}/${response.total_steps} steps (${percentage.toFixed(1)}%)`;
            }

            this.messages.push({
              text: messageText,
              sender: 'bot',
              avatar: '🤖',
              isVoice: true,
              sessionId: this.currentSessionId,
              stepNumber: this.currentStepNumber,
              feedback: null
            });

            this.scrollToBottom();
            
            // For voice output, use next_step.description for resumed work orders
            const voiceText = this.isResumedWorkOrder && response.next_step?.description
              ? `${response.message}. ${response.next_step.description}`
              : messageText;
            
            await this.speakText(voiceText);
          }
          
          this.isFeedbackInProgress = false;
          this.isProcessing = false;
          this.pendingFeedback.delete(proceedKey);
        },
        error: (error) => {
          console.error('[WorkOrderModal] Failed to proceed:', error);
          this.addMessage('Failed to proceed. Please try again.', 'bot');
          this.isFeedbackInProgress = false;
          this.isProcessing = false;
          this.pendingFeedback.delete(proceedKey);
          WorkOrderModalComponent.activeApiCalls.delete(globalKey); // Clean up global lock
        }
      });
    } catch (error) {
      console.error('[WorkOrderModal] Error:', error);
      this.isFeedbackInProgress = false;
      this.isProcessing = false;
      const proceedKey = `proceed-${this.currentSessionId}-${this.currentStepNumber}`;
      this.pendingFeedback.delete(proceedKey);
      const globalKey = `feedback-${this.currentSessionId}-${this.currentStepNumber}`;
      WorkOrderModalComponent.activeApiCalls.delete(globalKey); // Clean up global lock
      this.isProcessing = false;
    }
  }

  /**
   * Submit feedback for a message
   */
  submitFeedback(message: Message, isPositive: boolean): void {
    // Only allow feedback on messages that have proper session and step tracking
    if (!message.sessionId || message.stepNumber === undefined) {
      console.warn('[WorkOrderModal] ⚠️ Cannot submit feedback - message missing sessionId or stepNumber:', message);
      return;
    }
    
    // Check if feedback is already being submitted for this message
    const feedbackKey = `${message.sessionId}-${message.stepNumber}-${isPositive}`;
    if (this.pendingFeedback.has(feedbackKey)) {
      console.warn('[WorkOrderModal] ⚠️ DUPLICATE FEEDBACK - Already submitting:', feedbackKey);
      return;
    }
    
    // Check if feedback was already submitted
    if (message.feedback) {
      console.warn('[WorkOrderModal] ⚠️ Feedback already submitted for this message:', message.feedback);
      return;
    }

    const feedback = isPositive ? 'positive' : 'negative';
    this.isFeedbackInProgress = true;
    this.pendingFeedback.add(feedbackKey);

    console.log('[WorkOrderModal] 📝 Submitting feedback:', { 
      sessionId: message.sessionId, 
      stepNumber: message.stepNumber, 
      feedback 
    });

    this.feedbackService.submitFeedback(
      message.sessionId,
      message.stepNumber,
      feedback,
      '',
      1 // TODO: Get from AuthService
    ).subscribe({
      next: async (response) => {
        message.feedback = feedback;
        this.cdr.detectChanges();

        if (response.type === 'next_step' && response.message) {
          await this.handleNextStepResponse(response);
        } else if (response.type === 'complete' || response.type === 'work_order_complete') {
          await this.handleWorkOrderComplete(response);
        }
        
        this.isFeedbackInProgress = false;
        this.pendingFeedback.delete(feedbackKey);
      },
      error: (error) => {
        console.error('[WorkOrderModal] Feedback error:', error);
        this.isFeedbackInProgress = false;
        this.pendingFeedback.delete(feedbackKey);
      }
    });
  }

  /**
   * Handle next step response
   */
  private async handleNextStepResponse(response: any): Promise<void> {
    if (response.progress?.completed) {
      sessionStorage.setItem('completed_step', response.progress.completed.toString());
    }

    this.currentStepNumber++;

    let messageText = response.message;
    if (response.tts_text) {
      messageText += `\n\n${response.tts_text}`;
    }
    if (response.current_step?.estimated_time) {
      messageText += `\n\nEstimated time: ${response.current_step.estimated_time} hours`;
    }
    if (response.progress) {
      messageText += `\n\nProgress: ${response.progress.completed}/${response.progress.total} steps (${response.progress.percentage.toFixed(1)}%)`;
    }

    this.messages.push({
      text: messageText,
      sender: 'bot',
      avatar: '🤖',
      isVoice: true,
      sessionId: this.currentSessionId,
      stepNumber: this.currentStepNumber,
      feedback: null
    });

    this.scrollToBottom();
    await this.speakText(messageText);
  }

  /**
   * Handle work order complete
   */
  private async handleWorkOrderComplete(response: any): Promise<void> {
    sessionStorage.setItem('work_order_complete', 'true');
    
    // Format completion message with details
    let completionMessage = response.message || 'Work order completed successfully! 🎉';
    
    // Add summary information if available
    if (response.summary) {
      completionMessage += '\n\n📊 Work Order Summary:';
      
      if (response.summary.summary_text) {
        completionMessage += `\n${response.summary.summary_text}`;
      }
      
      if (response.summary.major_issues_resolved) {
        completionMessage += `\n\n🔧 Major Issues Resolved:\n${response.summary.major_issues_resolved}`;
      }
      
      if (response.summary.recommendations_for_customer) {
        completionMessage += `\n\n💡 Recommendations:\n${response.summary.recommendations_for_customer}`;
      }
    } else {
      // Fallback to individual fields if summary object not available
      if (response.total_steps) {
        completionMessage += `\n\n✅ Total Steps Completed: ${response.total_steps}`;
      }
      if (response.total_time) {
        const hours = typeof response.total_time === 'string' 
          ? Number.parseFloat(response.total_time).toFixed(2)
          : response.total_time.toFixed(2);
        completionMessage += `\n⏱️ Total Time: ${hours} hours`;
      }
    }
    
    this.addMessage(completionMessage, 'bot', true);
    
    // Create voice output with summary
    let speechText = response.message || 'Work order completed successfully!';
    
    if (response.summary?.summary_text) {
      speechText += ` ${response.summary.summary_text}`;
      
      if (response.summary.major_issues_resolved) {
        speechText += ` Major issues resolved: ${response.summary.major_issues_resolved}`;
      }
      
      if (response.summary.recommendations_for_customer) {
        speechText += ` Recommendations for customer: ${response.summary.recommendations_for_customer}`;
      }
    } else if (response.tts_text) {
      speechText = response.tts_text;
    }
    
    await this.speakText(speechText);
  }

  /**
   * Add message to chat
   */
  private addMessage(text: string, sender: 'user' | 'bot', isVoice = false): void {
    this.messages.push({
      text,
      sender,
      avatar: sender === 'user' ? '🧑' : '🤖',
      isVoice
    });
    this.cdr.detectChanges();
    this.scrollToBottom();
  }

  /**
   * Speak text using TTS
   */
  private async speakText(text: string): Promise<void> {
    try {
      this.isVoicePlaying = true;
      this.cdr.detectChanges(); // Force UI update
      await this.voiceApiService.speakText(text);
      this.isVoicePlaying = false;
      this.cdr.detectChanges(); // Force UI update to enable inputs
      
      // Restart wake word listener after TTS completes
      setTimeout(() => this.startModalWakeWordListener(), 500);
    } catch (error) {
      console.error('[WorkOrderModal] TTS error:', error);
      this.isVoicePlaying = false;
      this.cdr.detectChanges(); // Force UI update even on error
      
      // Restart wake word listener even on error
      setTimeout(() => this.startModalWakeWordListener(), 500);
    }
  }

  /**
   * Scroll to bottom of messages
   */
  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.messagesContainer) {
        const element = this.messagesContainer.nativeElement;
        element.scrollTop = element.scrollHeight;
      }
    }, 100);
  }

  /**
   * Check if speech recognition is supported
   */
  get isSpeechSupported(): boolean {
    return 'webkitSpeechRecognition' in window || 'SpeechRecognition' in window;
  }

  /**
   * Get current time
   */
  getCurrentTime(): string {
    return new Date().toLocaleTimeString('en-US', { 
      hour: '2-digit', 
      minute: '2-digit' 
    });
  }

  /**
   * Start wake word listener for modal
   */
  private startModalWakeWordListener(): void {
    console.log('[WorkOrderModal] Starting wake word listener for modal...');
    
    // Ensure any existing listener is stopped first
    try {
      this.wakeupVoiceService.stopListening();
    } catch (error) {
      console.error('[WorkOrderModal] Error stopping existing listener:', error);
    }
    
    // Start fresh listener for modal
    setTimeout(() => {
      this.wakeupVoiceService.startListening(
        () => {
          // Wake word "hey buddy" detected - start modal voice input
          console.log('[WorkOrderModal] Wake word detected! Starting voice input...');
          this.wakeupVoiceService.stopListening();
          this.toggleVoiceInput();
        }
      );
    }, 500); // Give time for previous listener to fully stop
  }
}
