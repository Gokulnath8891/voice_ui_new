import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import { AuthService } from '../services/auth.service';
import { FeedbackService } from '../services/feedback.service';
import { ApiRequestManagerService } from '../services/api-request-manager.service';

// Import interfaces from work-order service
export interface StartWorkRequest {
  query: string;
  user_id: number;
  type: 'text' | 'voice';
}

export interface WorkOrderStartResponse {
  type: 'work_order_start' | 'error';
  session_id?: string;
  message: string;
  tts_text?: string;
  work_order?: any;
  current_step?: any;
}

export interface NextStepRequest {
  session_id: string;
  query: string;
  feedback: string;
  user_id: number;
}

export interface NextStepResponse {
  type: 'next_step' | 'work_order_complete' | 'error';
  session_id?: string;
  message: string;
  tts_text?: string;
  current_step?: any;
  completed_step?: number;
  is_complete?: boolean;
}

export interface AgenticRagRequest {
  query: string;
}

export interface RetrievedDocument {
  id: number;
  score: number;
  content: string;
}

export interface PerSubQuery {
  subquery: string;
  rewritten: string;
  retrieved: RetrievedDocument[];
}

export interface Judge {
  reason: string;
  verdict: string;
}

export interface AgenticRagResponse {
  success: boolean;
  route: string;
  result: string;
  query: string;
  per_sub?: PerSubQuery[];
  judge?: Judge;
  context?: string;
  response?: string; // Fallback for old format
  tts_text?: string;
}

@Injectable({
  providedIn: 'root',
})
export class VoiceApiService {
  private readonly API_BASE_URL = environment.baseUrl;
  private readonly VOICE_ENDPOINT = `${this.API_BASE_URL}/search/query`;

  constructor(
    private readonly http: HttpClient,
    private readonly authService: AuthService,
    private readonly feedbackService: FeedbackService,
    private readonly apiRequestManager: ApiRequestManagerService
  ) {
    console.log(`[VoiceAPI] Service instance created`);
  }

  async sendVoiceMessage(transcribedText: string): Promise<{ response: string; audioResponse?: Blob }> {
    try {
      console.log(this.VOICE_ENDPOINT,"this.VOICE_ENDPOINT");
      const response = await fetch(this.VOICE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query: transcribedText,
          max_chunks: 5,
          similarity_threshold: 0.7,
        }),
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const contentType = response.headers.get('content-type');

      if (contentType?.includes('application/json')) {
        const jsonResponse = await response.json();
        return {
          response: jsonResponse.summary || jsonResponse.response || jsonResponse.answer || 'No response available',
        };
      } else if (contentType?.includes('audio')) {
        const audioResponse = await response.blob();
        return {
          response: response.headers.get('x-response-text') || 'Audio response received',
          audioResponse,
        };
      } else {
        throw new Error('Unexpected response format');
      }
    } catch (error) {
      console.error('Voice API error:', error);
      throw new Error('Failed to process voice message');
    }
  }

  async sendTextToAPI(text: string, isVoiceInput: boolean = false): Promise<string> {
    try {
      console.log(`[VoiceAPI] 🔵 sendTextToAPI:`, { text, isVoiceInput });
      
      // Check if this is a "proceed" or "completed" command for next step
      const nextStepPattern = /(?:proceed|continue|next|move\s+to\s+next|completed?)\s+(?:step|to\s+step)?/i;
      const sessionId = sessionStorage.getItem('current_session_id');
      
      if (nextStepPattern.test(text) && sessionId) {
        console.log('[VoiceAPI] Next step command detected');
        return await this.proceedNextStep(sessionId, text);
      }
      
      // NOTE: Work order commands (help me fix, start, resume, restart) are handled 
      // in chat-widget.component.ts to properly navigate and open the modal.
      // This service only handles general queries via agentic RAG.
      
      // For non-work-order queries, use the agentic RAG endpoint
      console.log('[VoiceAPI] Using agentic RAG endpoint for general query');
      return await this.queryAgenticRag(text);
    } catch (error) {
      console.error('Chat API error:', error);
      throw new Error('Failed to get chat response');
    }
  }

  /**
   * Start work order via chat API
   */
  async startWorkOrder(workOrderNumber: string, userId: number, type: 'text' | 'voice'): Promise<WorkOrderStartResponse> {
    console.log(`[VoiceAPI] 🚀 startWorkOrder:`, { workOrderNumber, userId, type });
    
    try {
      // Get authentication token
      const token = this.authService.getToken();
      if (!token) {
        throw new Error('Authentication required. Please log in.');
      }

      const payload: StartWorkRequest = {
        query: `help me fix ${workOrderNumber}`,
        user_id: userId,
        type
      };

      console.log(`[VoiceAPI] 📤 POST chat/query/`);

      // Use the centralized API request manager
      const result = await this.apiRequestManager.postPromise<WorkOrderStartResponse>(
        'chat/query/',
        payload
      );
      
      console.log(`[VoiceAPI] ✅ Response received for ${workOrderNumber}`);
      
      // Store session ID for future feedback submissions
      if (result.session_id) {
        sessionStorage.setItem('current_session_id', result.session_id);
        sessionStorage.setItem('current_work_order', workOrderNumber);
      }
      
      return result;
    } catch (error) {
      console.error(`[VoiceAPI] ❌ Work order API error:`, error);
      return {
        type: 'error',
        message: 'Failed to start work order. Please try again.'
      };
    }
  }

  /**
   * Proceed to next step in work order workflow using feedback API
   */
  async proceedNextStep(sessionId: string, userInput: string): Promise<string> {
    try {
      const userId = 1; // TODO: Get from auth service
      
      // Get current step number from sessionStorage or default to 1
      const completedStepStr = sessionStorage.getItem('completed_step');
      const stepNumber = completedStepStr ? Number.parseInt(completedStepStr, 10) : 1;

      console.log('[VoiceAPI] Proceeding to next step via feedback API:', {
        sessionId,
        stepNumber,
        userInput
      });

      // Use feedback service to submit "positive" feedback which triggers next step
      return new Promise((resolve, reject) => {
        this.feedbackService.submitFeedback(
          sessionId,
          stepNumber,
          'positive',
          userInput,
          userId
        ).subscribe({
          next: (response) => {
            console.log('[VoiceAPI] Next step response from feedback API:', response);

            if (response.type === 'work_order_complete') {
              // Store completion flag
              sessionStorage.setItem('work_order_complete', 'true');
              resolve(response.message || 'Work order completed successfully!');
              return;
            }

            if (response.type === 'next_step') {
              // Store completed step for UI update
              if (response.progress?.completed) {
                sessionStorage.setItem('completed_step', response.progress.completed.toString());
              }

              // Format response: message + tts_text
              let responseText = response.message || 'Proceeding to next step.';
              
              if (response.tts_text) {
                responseText += `\n\n${response.tts_text}`;
              }
              
              if (response.current_step?.estimated_time) {
                responseText += `\n\nEstimated time: ${response.current_step.estimated_time} hours`;
              }

              // Add progress info
              if (response.progress) {
                responseText += `\n\nProgress: ${response.progress.completed}/${response.progress.total} steps (${response.progress.percentage.toFixed(1)}%)`;
              }
              
              resolve(responseText);
              return;
            }
            
            resolve(response.message || 'Unable to proceed to next step');
          },
          error: (error) => {
            console.error('[VoiceAPI] Next step API error:', error);
            reject(new Error('Failed to proceed to next step. Please try again.'));
          }
        });
      });
    } catch (error) {
      console.error('[VoiceAPI] Error in proceedNextStep:', error);
      throw new Error('Failed to proceed to next step. Please try again.');
    }
  }

  /**
   * Query agentic RAG endpoint for general queries
   * Returns the result field from the response
   */
  async queryAgenticRag(query: string): Promise<string> {
    const callId = Math.random().toString(36).substring(7);
    
    console.log(`[VoiceAPI] 🔍 queryAgenticRag [${callId}]:`, query);
    
    try {
      // Get authentication token
      const token = this.authService.getToken();
      if (!token) {
        throw new Error('Authentication required. Please log in.');
      }

      const payload: AgenticRagRequest = {
        query
      };

      console.log(`[VoiceAPI] 📤 POST agentic-rag/query/`);

      // Use the centralized API request manager
      const result = await this.apiRequestManager.postPromise<AgenticRagResponse>(
        'agentic-rag/query/',
        payload
      );
      
      console.log(`[VoiceAPI] ✅ Agentic RAG response received [${callId}]`);
      
      // Return the result field from the new format
      // Fallback to old format if needed
      if (result.success && result.result) {
        return result.result;
      }
      
      // Fallback to old format
      return result.response || result.tts_text || 'No response available';
    } catch (error) {
      console.error(`[VoiceAPI] ❌ Agentic RAG error [${callId}]:`, error);
      throw new Error('Failed to get response from agentic RAG. Please try again.');
    }
  }

  speakText(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if ('speechSynthesis' in globalThis) {
        // Cancel any pending speech to prevent queuing/duplicates
        if (speechSynthesis.speaking || speechSynthesis.pending) {
          console.log('[VoiceAPI] 🛑 Canceling pending speech before starting new utterance');
          speechSynthesis.cancel();
        }
        
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1;
        utterance.volume = 0.8;

        utterance.onend = () => {
          console.log('[VoiceAPI] ✅ Speech completed');
          resolve();
        };
        utterance.onerror = (event) => {
          console.error('[VoiceAPI] ❌ Speech error:', event.error);
          reject(new Error(`Speech synthesis error: ${event.error}`));
        };

        console.log('[VoiceAPI] 🔊 Starting speech synthesis');
        speechSynthesis.speak(utterance);
      } else {
        reject(new Error('Speech synthesis not supported'));
      }
    });
  }
}
