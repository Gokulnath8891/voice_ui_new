import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { shareReplay, tap, finalize } from 'rxjs/operators';
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
    
    console.log(`[FeedbackService] 🎯 submitFeedback called:`, { sessionId, stepNumber, feedback, feedbackKey });
    
    // CRITICAL: Check if this exact feedback call is already in progress GLOBALLY
    if (FeedbackService.pendingFeedbackCalls.has(feedbackKey)) {
      console.warn(`[FeedbackService] ⛔ DUPLICATE FEEDBACK CALL BLOCKED - Returning cached observable:`, feedbackKey);
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

    console.log(`[FeedbackService] 📤 Making HTTP POST to: ${this.apiUrl}/chat/feedback/`);

    // Create the observable with shareReplay to ensure only ONE HTTP call
    const feedbackObservable = this.http.post<FeedbackResponse>(
      `${this.apiUrl}/chat/feedback/`,
      payload,
      { headers }
    ).pipe(
      tap(() => console.log(`[FeedbackService] ✅ Feedback call SUCCESS [${feedbackKey}]`)),
      finalize(() => {
        console.log(`[FeedbackService] 🧹 Cleaning up [${feedbackKey}]`);
        FeedbackService.pendingFeedbackCalls.delete(feedbackKey);
      }),
      shareReplay(1) // Share the result with all subscribers, only make ONE HTTP call
    );
    
    // Store the pending call GLOBALLY
    FeedbackService.pendingFeedbackCalls.set(feedbackKey, feedbackObservable);
    
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
    const feedbackKey = `wo-${workOrderId}-${stepId}`;
    
    console.log(`[FeedbackService] 🎯 submitWorkOrderFeedback called:`, { workOrderId, stepId, feedbackKey });
    
    // CRITICAL: Check if this exact work order feedback call is already in progress GLOBALLY
    if (FeedbackService.pendingWorkOrderFeedbackCalls.has(feedbackKey)) {
      console.warn(`[FeedbackService] ⛔ DUPLICATE WORK ORDER FEEDBACK BLOCKED - Returning cached observable:`, feedbackKey);
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

    console.log(`[FeedbackService] 📤 Making HTTP POST to: ${this.apiUrl}/workorders/${workOrderId}/feedback/`);

    // Create the observable with shareReplay to ensure only ONE HTTP call
    const feedbackObservable = this.http.post<FeedbackResponse>(
      `${this.apiUrl}/workorders/${workOrderId}/feedback/`,
      payload,
      { headers }
    ).pipe(
      tap(() => console.log(`[FeedbackService] ✅ Work order feedback SUCCESS [${feedbackKey}]`)),
      finalize(() => {
        console.log(`[FeedbackService] 🧹 Cleaning up [${feedbackKey}]`);
        FeedbackService.pendingWorkOrderFeedbackCalls.delete(feedbackKey);
      }),
      shareReplay(1) // Share the result with all subscribers, only make ONE HTTP call
    );
    
    // Store the pending call GLOBALLY
    FeedbackService.pendingWorkOrderFeedbackCalls.set(feedbackKey, feedbackObservable);
    
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
