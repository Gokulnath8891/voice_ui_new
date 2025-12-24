import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from 'src/environments/environment';
import { AuthService } from './auth.service';

export interface FeedbackRequest {
  session_id: string;
  step_number: number;
  feedback: 'positive' | 'negative';
  notes: string;
  user_id: number;
}

export interface WorkOrderFeedbackRequest {
  step_id: number;
  feedback_text: string;
  time_spent: number;
}

export interface CurrentStep {
  id?: number;
  step_number: number;
  title: string;
  description: string;
  instruction: string;
  estimated_time: number;
}

export interface Progress {
  completed: number;
  total: number;
  percentage: number;
}

export interface FeedbackResponse {
  status?: string;
  message: string;
  type?: string;
  tts_text?: string;
  current_step?: CurrentStep;
  next_step?: CurrentStep; // For work order feedback endpoint
  progress?: Progress;
  instruction?: string;
  total_steps?: number;
  total_time?: number | string;
  completed_steps?: number; // For work order feedback endpoint
}

export interface FeedbackHistoryItem {
  id: number;
  session_id: string;
  step_number: number;
  feedback: 'positive' | 'negative';
  notes: string;
  created_at: string;
}

export interface FeedbackHistoryResponse {
  feedbacks: FeedbackHistoryItem[];
}

@Injectable({
  providedIn: 'root'
})
export class FeedbackService {
  private readonly apiUrl = environment.apiUrl;
  
  // Static global locks to prevent duplicate feedback API calls across all service instances
  private static pendingFeedbackCalls = new Map<string, Observable<FeedbackResponse>>();
  private static pendingWorkOrderFeedbackCalls = new Map<string, Observable<FeedbackResponse>>();

  constructor(
    private readonly http: HttpClient,
    private readonly authService: AuthService
  ) {}

  /**
   * Submit feedback for a chat/work order step
   */
  submitFeedback(
    sessionId: string, 
    stepNumber: number, 
    feedback: 'positive' | 'negative', 
    notes: string = '',
    userId: number = 1
  ): Observable<FeedbackResponse> {
    // Create unique key for this feedback request
    const feedbackKey = `${sessionId}-${stepNumber}-${feedback}-${userId}`;
    
    console.log(`[FeedbackService] 🎯 submitFeedback called:`, { sessionId, stepNumber, feedback, notes, userId, feedbackKey });
    console.trace(`[FeedbackService] submitFeedback call stack`);
    
    // CRITICAL: Check if this exact feedback call is already in progress GLOBALLY
    if (FeedbackService.pendingFeedbackCalls.has(feedbackKey)) {
      console.warn(`[FeedbackService] ⛔ DUPLICATE FEEDBACK CALL BLOCKED GLOBALLY - Already in progress:`, {
        sessionId,
        stepNumber,
        feedback,
        feedbackKey
      });
      // Return the existing observable instead of making a duplicate call
      return FeedbackService.pendingFeedbackCalls.get(feedbackKey)!;
    }
    
    const token = this.authService.getToken();
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    });

    const payload: FeedbackRequest = {
      session_id: sessionId,
      step_number: stepNumber,
      feedback: feedback,
      notes: notes,
      user_id: userId
    };

    console.log(`[FeedbackService] 📤 Sending feedback request to: ${this.apiUrl}/chat/feedback/`);
    console.log(`[FeedbackService] 📦 Payload:`, payload);

    // Create the observable
    const feedbackObservable = this.http.post<FeedbackResponse>(
      `${this.apiUrl}/chat/feedback/`,
      payload,
      { headers }
    );
    
    // Store the pending call GLOBALLY
    FeedbackService.pendingFeedbackCalls.set(feedbackKey, feedbackObservable);
    
    // Clean up after the call completes (automatically handled by RxJS completion)
    feedbackObservable.subscribe({
      next: () => {
        console.log(`[FeedbackService] ✅ Feedback call completed [${feedbackKey}] - Removing from pending map`);
        FeedbackService.pendingFeedbackCalls.delete(feedbackKey);
      },
      error: () => {
        console.log(`[FeedbackService] ❌ Feedback call failed [${feedbackKey}] - Removing from pending map`);
        FeedbackService.pendingFeedbackCalls.delete(feedbackKey);
      }
    });
    
    return feedbackObservable;
  }

  /**
   * Submit feedback for resumed work order step
   */
  submitWorkOrderFeedback(
    workOrderId: number,
    stepId: number,
    feedbackText: string,
    timeSpent: number = 0.5
  ): Observable<FeedbackResponse> {
    // Create unique key for this work order feedback request
    const feedbackKey = `wo-${workOrderId}-${stepId}-${feedbackText.substring(0, 20)}`;
    
    console.log(`[FeedbackService] 🎯 submitWorkOrderFeedback called:`, { workOrderId, stepId, feedbackText, timeSpent, feedbackKey });
    console.trace(`[FeedbackService] submitWorkOrderFeedback call stack`);
    
    // CRITICAL: Check if this exact work order feedback call is already in progress GLOBALLY
    if (FeedbackService.pendingWorkOrderFeedbackCalls.has(feedbackKey)) {
      console.warn(`[FeedbackService] ⛔ DUPLICATE WORK ORDER FEEDBACK CALL BLOCKED GLOBALLY - Already in progress:`, {
        workOrderId,
        stepId,
        feedbackText,
        feedbackKey
      });
      // Return the existing observable instead of making a duplicate call
      return FeedbackService.pendingWorkOrderFeedbackCalls.get(feedbackKey)!;
    }
    
    const token = this.authService.getToken();
    const headers = new HttpHeaders({
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    });

    const payload: WorkOrderFeedbackRequest = {
      step_id: stepId,
      feedback_text: feedbackText,
      time_spent: timeSpent
    };

    console.log(`[FeedbackService] 📤 Sending work order feedback request to: ${this.apiUrl}/workorders/${workOrderId}/feedback/`);
    console.log(`[FeedbackService] 📦 Payload:`, payload);

    // Create the observable
    const feedbackObservable = this.http.post<FeedbackResponse>(
      `${this.apiUrl}/workorders/${workOrderId}/feedback/`,
      payload,
      { headers }
    );
    
    // Store the pending call GLOBALLY
    FeedbackService.pendingWorkOrderFeedbackCalls.set(feedbackKey, feedbackObservable);
    
    // Clean up after the call completes (automatically handled by RxJS completion)
    feedbackObservable.subscribe({
      next: () => {
        console.log(`[FeedbackService] ✅ Work order feedback call completed [${feedbackKey}] - Removing from pending map`);
        FeedbackService.pendingWorkOrderFeedbackCalls.delete(feedbackKey);
      },
      error: () => {
        console.log(`[FeedbackService] ❌ Work order feedback call failed [${feedbackKey}] - Removing from pending map`);
        FeedbackService.pendingWorkOrderFeedbackCalls.delete(feedbackKey);
      }
    });
    
    return feedbackObservable;
  }

  /**
   * Get feedback history for a work order
   */
  getFeedbackHistory(workorderId: number): Observable<FeedbackHistoryResponse> {
    const token = this.authService.getToken();
    const headers = new HttpHeaders({
      'Authorization': `Bearer ${token}`
    });

    return this.http.get<FeedbackHistoryResponse>(
      `${this.apiUrl}/workorder/${workorderId}/feedback/`,
      { headers }
    );
  }
}
