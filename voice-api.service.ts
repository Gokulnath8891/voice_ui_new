import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { environment } from 'src/environments/environment';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../services/auth.service';
import { FeedbackService } from '../services/feedback.service';

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
  private readonly CHAT_ENDPOINT = `${this.API_BASE_URL}/chat`;
  private readonly CHAT_QUERY_ENDPOINT = `${environment.apiUrl}/chat/query/`;
  private readonly AGENTIC_RAG_ENDPOINT = `${environment.apiUrl}/agentic-rag/query/`;
  
  // Duplicate detection
  private lastApiCall: { workOrder: string; type: string; timestamp: number } | null = null;
  private lastAgenticRagCall: { query: string; timestamp: number; response: string } | null = null;
  private readonly API_DUPLICATE_THRESHOLD_MS = 3000; // 3 seconds to allow for API response time
  private static callCounter = 0; // Global call counter across all instances
  private instanceId: string;
  private pendingAgenticRagCalls: Map<string, Promise<string>> = new Map();
  
  // Static global locks to prevent duplicate API calls across all service instances
  private static pendingWorkOrderCalls = new Map<string, Promise<WorkOrderStartResponse>>();
  private static pendingChatQueryCalls = new Map<string, Promise<string>>();

  constructor(
    private readonly http: HttpClient,
    private readonly authService: AuthService,
    private readonly feedbackService: FeedbackService
  ) {
    this.instanceId = Math.random().toString(36).substring(7);
    VoiceApiService.callCounter++;
    console.log(`[VoiceAPI] 🏗️ Service instance created [${this.instanceId}] - Total instances: ${VoiceApiService.callCounter}`);
    console.trace('[VoiceAPI] Service instantiation stack');
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
      const callId = Math.random().toString(36).substring(7);
      console.log(`[VoiceAPI:${this.instanceId}] 🔵 sendTextToAPI START [${callId}]`, { text, isVoiceInput });
      console.trace(`[VoiceAPI:${this.instanceId}] Call stack for [${callId}]`);
      
      // Check if this is a "proceed" or "completed" command for next step
      const nextStepPattern = /(?:proceed|continue|next|move\s+to\s+next|completed?)\s+(?:step|to\s+step)?/i;
      const sessionId = sessionStorage.getItem('current_session_id');
      
      if (nextStepPattern.test(text) && sessionId) {
        console.log('[VoiceAPI] Next step command detected:', text);
        return await this.proceedNextStep(sessionId, text);
      }
      
      // Check if this is a work order request
      // Pattern 1: "help me fix WO-20241009" or "help me to fix WO-20241009"
      // Pattern 2: "help me fix work order 20241009" or "help me to fix work order 20241009"
      // Updated patterns to capture full number including variations like "20 24 10 01"
      const workOrderPattern1 = /help\s+me\s+(?:to\s+)?fix\s+(?:wo[-\s]?)?(\d+(?:\s*\d+)*)/i;
      const workOrderPattern2 = /help\s+me\s+(?:to\s+)?fix\s+work\s+order\s+(\d+(?:\s*\d+)*)/i;
      
      let match = workOrderPattern2.exec(text); // Try "work order" pattern first
      let workOrderNumber = '';
      
      if (match) {
        // Remove spaces from the number (in case speech recognition separates digits)
        const numberPart = match[1].replaceAll(/\s+/g, '');
        workOrderNumber = `WO-${numberPart}`;
        console.log('[VoiceAPI] Work order detected (pattern 2):', workOrderNumber);
      } else {
        match = workOrderPattern1.exec(text);
        if (match) {
          // Remove spaces from the number
          const numberPart = match[1].replaceAll(/\s+/g, '');
          workOrderNumber = `WO-${numberPart}`;
          console.log('[VoiceAPI] Work order detected (pattern 1):', workOrderNumber);
        }
      }
      
      if (workOrderNumber) {
        console.log('[VoiceAPI:' + this.instanceId + '] 📋 Final work order number:', workOrderNumber);
        const userId = 1; // TODO: Get from auth service
        
        // Determine the type based on input method
        const inputType: 'text' | 'voice' = isVoiceInput ? 'voice' : 'text';
        console.log('[VoiceAPI:' + this.instanceId + '] 📞 Calling startWorkOrder with type:', inputType);
        
        // Call the work order start API
        const workOrderResponse = await this.startWorkOrder(workOrderNumber, userId, inputType);
        
        if (workOrderResponse.type === 'work_order_start') {
          let responseText = workOrderResponse.message;
          
          if (workOrderResponse.current_step) {
            responseText += `\n\nStep ${workOrderResponse.current_step.step_number}:\n${workOrderResponse.current_step.description}`;
            
            if (workOrderResponse.current_step.estimated_time) {
              responseText += `\n\nEstimated time: ${workOrderResponse.current_step.estimated_time}`;
            }
          }
          
          return responseText;
        } else {
          return workOrderResponse.message || 'Error starting work order';
        }
      }
      
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
    const workOrderKey = `${workOrderNumber}-${userId}-${type}`;
    
    console.log(`[VoiceAPI:${this.instanceId}] 🚀 startWorkOrder called:`, { workOrderNumber, userId, type, workOrderKey });
    console.trace(`[VoiceAPI:${this.instanceId}] Call stack trace`);
    
    // CRITICAL: Check if this exact work order call is already in progress GLOBALLY
    if (VoiceApiService.pendingWorkOrderCalls.has(workOrderKey)) {
      console.warn(`[VoiceAPI:${this.instanceId}] ⛔ DUPLICATE WORK ORDER CALL BLOCKED GLOBALLY - Already in progress:`, {
        workOrderNumber,
        userId,
        type,
        workOrderKey
      });
      // Return the existing promise instead of making a duplicate call
      return VoiceApiService.pendingWorkOrderCalls.get(workOrderKey)!;
    }
    
    // Create the API call promise
    const apiCallPromise = this.executeWorkOrderCall(workOrderNumber, userId, type, workOrderKey);
    
    // Store the pending call GLOBALLY
    VoiceApiService.pendingWorkOrderCalls.set(workOrderKey, apiCallPromise);
    
    // Clean up after the call completes (success or failure)
    apiCallPromise
      .then((response) => {
        console.log(`[VoiceAPI:${this.instanceId}] ✅ Work order call completed [${workOrderKey}] - Removing from pending map`);
        VoiceApiService.pendingWorkOrderCalls.delete(workOrderKey);
        return response;
      })
      .catch((error) => {
        console.log(`[VoiceAPI:${this.instanceId}] ❌ Work order call failed [${workOrderKey}] - Removing from pending map`);
        VoiceApiService.pendingWorkOrderCalls.delete(workOrderKey);
        throw error;
      });
    
    return apiCallPromise;
  }
  
  /**
   * Execute the actual work order API call
   */
  private async executeWorkOrderCall(workOrderNumber: string, userId: number, type: 'text' | 'voice', workOrderKey: string): Promise<WorkOrderStartResponse> {
    try {
      console.log(`[VoiceAPI:${this.instanceId}] 📞 Executing work order API call [${workOrderKey}]`);
      
      // Check for duplicate API calls (legacy check - now redundant with global lock)
      const now = Date.now();
      if (this.lastApiCall) {
        const timeSinceLastCall = now - this.lastApiCall.timestamp;
        const isSameWorkOrder = this.lastApiCall.workOrder === workOrderNumber;
        
        if (isSameWorkOrder && timeSinceLastCall < this.API_DUPLICATE_THRESHOLD_MS) {
          console.warn(`[VoiceAPI:${this.instanceId}] ⚠️ DUPLICATE API CALL BLOCKED (Timestamp check):`, {
            workOrderNumber,
            type,
            lastCallType: this.lastApiCall.type,
            timeSinceLastCall: `${timeSinceLastCall}ms`,
            threshold: `${this.API_DUPLICATE_THRESHOLD_MS}ms`
          });
          
          // Return error response
          return {
            type: 'error',
            message: 'Duplicate request detected and blocked to prevent double processing.'
          };
        }
      }
      
      // Update last API call tracker
      this.lastApiCall = { workOrder: workOrderNumber, type, timestamp: now };
      
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

      console.log(`[VoiceAPI:${this.instanceId}] 📤 Sending request to:`, this.CHAT_QUERY_ENDPOINT);
      console.log(`[VoiceAPI:${this.instanceId}] 📦 Payload:`, payload);

      const response = await fetch(this.CHAT_QUERY_ENDPOINT, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Authentication failed. Please log in again.');
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result: WorkOrderStartResponse = await response.json();
      
      console.log(`[VoiceAPI:${this.instanceId}] 📥 Response received:`, result);
      
      // Store session ID for future feedback submissions
      if (result.session_id) {
        sessionStorage.setItem('current_session_id', result.session_id);
        sessionStorage.setItem('current_work_order', workOrderNumber);
      }
      
      return result;
    } catch (error) {
      console.error(`[VoiceAPI:${this.instanceId}] Work order start API error:`, error);
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
      const stepNumber = completedStepStr ? parseInt(completedStepStr, 10) : 1;

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
    const queryKey = query.toLowerCase().trim();
    
    console.log(`[VoiceAPI:${this.instanceId}] 🔍 queryAgenticRag [${callId}] START - query:`, query);
    console.trace(`[VoiceAPI:${this.instanceId}] queryAgenticRag [${callId}] call stack`);
    
    // Check if there's already a pending call for this exact query
    if (this.pendingAgenticRagCalls.has(queryKey)) {
      console.warn(`[VoiceAPI:${this.instanceId}] ⚠️ DUPLICATE CALL [${callId}] DETECTED - Returning existing promise for:`, query);
      return this.pendingAgenticRagCalls.get(queryKey)!;
    }
    
    // Create the API call promise
    const apiCallPromise = this.executeAgenticRagCall(query, callId);
    
    // Store the pending call
    this.pendingAgenticRagCalls.set(queryKey, apiCallPromise);
    
    // Clean up after the call completes (success or failure)
    apiCallPromise
      .then(() => {
        console.log(`[VoiceAPI:${this.instanceId}] ✅ Removing completed call [${callId}] from pending map`);
        this.pendingAgenticRagCalls.delete(queryKey);
      })
      .catch(() => {
        console.log(`[VoiceAPI:${this.instanceId}] ❌ Removing failed call [${callId}] from pending map`);
        this.pendingAgenticRagCalls.delete(queryKey);
      });
    
    return apiCallPromise;
  }
  
  private async executeAgenticRagCall(query: string, callId: string): Promise<string> {
    try {
      // Get authentication token
      const token = this.authService.getToken();
      if (!token) {
        throw new Error('Authentication required. Please log in.');
      }

      const payload: AgenticRagRequest = {
        query
      };

      console.log(`[VoiceAPI:${this.instanceId}] 📤 Making fetch request [${callId}]`);

      const response = await fetch(this.AGENTIC_RAG_ENDPOINT, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        if (response.status === 401) {
          throw new Error('Authentication failed. Please log in again.');
        }
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result: AgenticRagResponse = await response.json();
      
      console.log(`[VoiceAPI:${this.instanceId}] 📥 Agentic RAG response received:`, result);
      
      // Return the result field from the new format
      // Fallback to old format if needed
      if (result.success && result.result) {
        console.log(`[VoiceAPI:${this.instanceId}] ✅ Returning result:`, result.result);
        console.log(`[VoiceAPI:${this.instanceId}] Route:`, result.route);
        console.log(`[VoiceAPI:${this.instanceId}] Query:`, result.query);
        if (result.per_sub) {
          console.log(`[VoiceAPI:${this.instanceId}] Sub-queries:`, result.per_sub.length);
        }
        if (result.judge) {
          console.log(`[VoiceAPI:${this.instanceId}] Judge verdict:`, result.judge.verdict);
        }
        return result.result;
      }
      
      // Fallback to old format
      return result.response || result.tts_text || 'No response available';
    } catch (error) {
      console.error('Agentic RAG API error:', error);
      throw new Error('Failed to get response from agentic RAG. Please try again.');
    }
  }

  speakText(text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if ('speechSynthesis' in globalThis) {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = 0.9;
        utterance.pitch = 1;
        utterance.volume = 0.8;

        utterance.onend = () => resolve();
        utterance.onerror = (event) => reject(new Error(`Speech synthesis error: ${event.error}`));

        speechSynthesis.speak(utterance);
      } else {
        reject(new Error('Speech synthesis not supported'));
      }
    });
  }
}
