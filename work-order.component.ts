import { HttpClient } from '@angular/common/http';
import { Component, OnInit, OnDestroy, ViewChild, AfterViewInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { SidebarModule } from 'primeng/sidebar';
import { ButtonModule } from 'primeng/button';
import { ChipModule } from 'primeng/chip';
import { InputTextareaModule } from 'primeng/inputtextarea';
import { AvatarModule } from 'primeng/avatar';
import { CommonModule } from '@angular/common';
import { InputTextModule } from 'primeng/inputtext';
import { TableModule } from 'primeng/table';
import { CardModule } from 'primeng/card';
import { TagModule } from 'primeng/tag';
import { BadgeModule } from 'primeng/badge';
import { PaginatorModule } from 'primeng/paginator';
import { WorkOrderService } from '../services/work-order.service';
import { ChatCommunicationService } from '../services/chat-communication.service';
import { AuthService } from '../services/auth.service';
import { WorkOrderModalComponent } from './work-order-modal.component';
import { WorkOrderActionService } from '../services/work-order-action.service';
import { Subscription } from 'rxjs';

@Component({
  selector: 'work-order',
  standalone: true,
  imports: [
    FormsModule, 
    SidebarModule, 
    ButtonModule, 
    ChipModule, 
    InputTextareaModule, 
    AvatarModule, 
    CommonModule,
    InputTextModule,
    TableModule,
    CardModule,
    TagModule,
    BadgeModule,
    PaginatorModule,
    WorkOrderModalComponent
],
  templateUrl: './work-order.component.html',
  styleUrl: './work-order.component.scss'
})
export class WorkOrderComponent implements OnInit, AfterViewInit, OnDestroy {
  @ViewChild(WorkOrderModalComponent) workOrderModal!: WorkOrderModalComponent;
  
  selectedTab: string = 'All';
  selectedPriority: string = 'All';
  
  statusTabs = [
    { label: 'All', value: 'All' },
    { label: 'Pending', value: 'Pending' },
    { label: 'Assigned', value: 'Assigned' },
    { label: 'In Progress', value: 'In Progress' },
    { label: 'Completed', value: 'Completed' }
  ];

  priorityTabs = [
    { label: 'All', value: 'All' },
    { label: 'High', value: 'High' },
    { label: 'Medium', value: 'Medium' },
    { label: 'Low', value: 'Low' }
  ];

  workOrders: any[] = [];
  filteredWorkOrders: any[] = [];
  paginatedWorkOrders: any[] = [];
  isLoading = false;
  errorMessage = '';
  
  // Pagination properties
  currentPage: number = 0;
  itemsPerPage: number = 8;

  // Subscriptions
  private voiceCompleteSubscription?: Subscription;
  private workOrderActionSubscription?: Subscription;
  
  // Flag to track if work orders have loaded
  private workOrdersLoaded = false;

  constructor(
    private readonly http: HttpClient,
    private readonly workOrderService: WorkOrderService,
    private readonly chatService: ChatCommunicationService,
    private readonly authService: AuthService,
    private readonly workOrderActionService: WorkOrderActionService
  ) {}

  ngOnInit() {
    this.loadWorkOrders();
    this.subscribeToVoiceCompletion();
    this.subscribeToWorkOrderActions();
  }

  ngAfterViewInit() {
    // Check for pending actions after view is initialized and modal is available
    this.checkPendingWorkOrderAction();
  }

  ngOnDestroy() {
    if (this.voiceCompleteSubscription) {
      this.voiceCompleteSubscription.unsubscribe();
    }
    if (this.workOrderActionSubscription) {
      this.workOrderActionSubscription.unsubscribe();
    }
  }

  /**
   * Subscribe to voice completion events to mark steps as completed
   */
  private subscribeToVoiceCompletion() {
    this.voiceCompleteSubscription = this.chatService.voiceComplete$.subscribe(() => {
      console.log('[WorkOrder] Voice synthesis completed, checking for step completion...');
      
      // Check if there's a completed step in sessionStorage
      const completedStepStr = sessionStorage.getItem('completed_step');
      if (completedStepStr) {
        const completedStepNumber = parseInt(completedStepStr, 10);
        console.log('[WorkOrder] Marking step as completed:', completedStepNumber);
        
        // Get current work order from sessionStorage
        const currentWorkOrderStr = sessionStorage.getItem('current_work_order');
        if (currentWorkOrderStr) {
          try {
            const currentWorkOrder = JSON.parse(currentWorkOrderStr);
            
            // Find the work order in our list
            const workOrder = this.workOrders.find(wo => wo.id === currentWorkOrder.id);
            if (workOrder && workOrder.steps) {
              // Mark the step as completed
              const step = workOrder.steps.find((s: any) => s.number === completedStepNumber);
              if (step) {
                step.completed = true;
                console.log('[WorkOrder] Step marked as completed in UI:', step);
                
                // Trigger change detection by updating the filtered and paginated lists
                this.applyFilters();
              }
            }
          } catch (error) {
            console.error('[WorkOrder] Error parsing current_work_order:', error);
          }
        }
        
        // Clear the completed step from sessionStorage
        sessionStorage.removeItem('completed_step');
      }
      
      // Check if work order is complete
      const workOrderComplete = sessionStorage.getItem('work_order_complete');
      if (workOrderComplete === 'true') {
        console.log('[WorkOrder] Work order is complete!');
        // TODO: Show completion message or update UI
        sessionStorage.removeItem('work_order_complete');
      }
    });
  }

  /**
   * Create a standardized callback for when modal closes
   */
  private createModalCloseCallback(): () => void {
    return () => {
      console.log('[WorkOrder] Modal closed, reloading work orders...');
      // Clear any pending action to prevent re-triggering on refresh
      sessionStorage.removeItem('pending_work_order_action');
      this.loadWorkOrders();
    };
  }

  /**
   * Subscribe to work order action events from chat widget
   */
  private subscribeToWorkOrderActions() {
    console.log('[WorkOrder] 🎧 Setting up action subscription...');
    this.workOrderActionSubscription = this.workOrderActionService.action$.subscribe((action) => {
      console.log('[WorkOrder] 🎯 Received work order action:', action);
      
      // Wait a tiny bit to ensure modal is available if not already
      setTimeout(() => {
        this.openModalForAction(action.orderNumber, action.action);
      }, 100);
    });
    console.log('[WorkOrder] ✅ Action subscription active');
  }

  /**
   * Open modal for a specific work order action
   */
  private openModalForAction(orderNumber: string, action: 'start' | 'resume' | 'restart') {
    console.log('[WorkOrder] 🚀 Opening modal directly for:', orderNumber, 'Action:', action);
    
    if (!this.workOrderModal) {
      console.error('[WorkOrder] ❌ Modal not available yet, will retry...');
      setTimeout(() => {
        this.openModalForAction(orderNumber, action);
      }, 200);
      return;
    }
    
    // Open modal immediately
    console.log('[WorkOrder] ✅ Opening modal NOW');
    this.workOrderModal.open(
      orderNumber,
      undefined,
      action,
      this.createModalCloseCallback()
    );
  }

  /**
   * Check for pending work order actions from voice commands
   * @deprecated This sessionStorage mechanism is being phased out in favor of the action service.
   * It remains temporarily for backward compatibility with old sessionStorage data.
   * New actions should only use workOrderActionService.triggerAction().
   */
  private checkPendingWorkOrderAction() {
    const pendingActionStr = sessionStorage.getItem('pending_work_order_action');
    console.log('[WorkOrder] Checking for pending action:', pendingActionStr);
    
    if (pendingActionStr) {
      console.log('[WorkOrder] Found pending action, will process after data loads');
      // Don't clear it yet - let processPendingAction handle it
    } else {
      console.log('[WorkOrder] No pending action found');
    }
  }

  /**
   * Process the pending work order action after data is loaded
   * @deprecated This sessionStorage mechanism is being phased out.
   * It remains for backward compatibility with old sessionStorage data.
   * After processing, the sessionStorage is cleared to prevent re-triggering on page refresh.
   */
  private processPendingAction() {
    const pendingActionStr = sessionStorage.getItem('pending_work_order_action');
    
    if (!pendingActionStr) {
      console.log('[WorkOrder] No pending action to process');
      return;
    }
    
    try {
      const pendingAction = JSON.parse(pendingActionStr);
      console.log('[WorkOrder] ⚡ Processing pending action:', pendingAction);
      
      // Clear the pending action immediately to prevent duplicate processing
      sessionStorage.removeItem('pending_work_order_action');
      
      // Check if modal is available
      if (!this.workOrderModal) {
        console.error('[WorkOrder] ❌ Modal not available in processPendingAction');
        // Store it back for retry
        sessionStorage.setItem('pending_work_order_action', pendingActionStr);
        
        // Retry after a delay
        setTimeout(() => {
          console.log('[WorkOrder] 🔄 Retrying pending action...');
          this.processPendingAction();
        }, 300); // Reduced delay for faster opening
        return;
      }
      
      console.log('[WorkOrder] ✅ Work orders loaded and modal available, opening NOW:', pendingAction);
      console.log('[WorkOrder] 📋 Order Number:', pendingAction.orderNumber);
      console.log('[WorkOrder] 🎬 Action:', pendingAction.action);
      
      // Open modal immediately with the appropriate action
      // Use setTimeout with 0 delay to ensure it's in the next tick after view is stable
      setTimeout(() => {
        console.log('[WorkOrder] 🚀 Opening modal now...');
        this.workOrderModal.open(
          pendingAction.orderNumber, 
          undefined, // No chat widget reference needed
          pendingAction.action, 
          this.createModalCloseCallback()
        );
        console.log('[WorkOrder] 📂 Modal.open() called successfully');
      }, 0);
    } catch (error) {
      console.error('[WorkOrder] ❌ Error processing pending action:', error);
      sessionStorage.removeItem('pending_work_order_action');
    }
  }

  async loadWorkOrders() {
    this.isLoading = true;
    this.errorMessage = '';
    
    try {
      const rawWorkOrders = await this.workOrderService.getAllWorkOrders();
      
      console.log('[WorkOrder] Raw API response from service:', rawWorkOrders);
      
      // The service already transforms the data, so we just need to enhance it
      this.workOrders = rawWorkOrders.map((order: any) => {
        // Service already provides: id, title, description, status, priority, assignee, vehicle, estimatedHours, dueDate, steps
        // We just need to add button states based on completed steps
        
        const completedSteps = order.steps ? order.steps.filter((s: any) => s.completed).length : 0;
        const totalSteps = order.steps ? order.steps.length : 0;
        
        // Determine button state
        let showResumeButton = false;
        let showRestartButton = false;
        
        // Only show Resume/Restart if work has been started but not fully completed
        if (completedSteps > 0 && completedSteps < totalSteps) {
          showResumeButton = true;
          showRestartButton = true;
        } else if (completedSteps === totalSteps && totalSteps > 0) {
          // All steps completed - only show Restart button (Resume is already false)
          showRestartButton = true;
        }
        
        return {
          ...order,
          completedSteps: completedSteps,
          totalSteps: totalSteps,
          showResumeButton: showResumeButton,
          showRestartButton: showRestartButton
        };
      });
      
      console.log('[WorkOrder] Final workOrders array:', this.workOrders);
      
      this.filteredWorkOrders = [...this.workOrders];
      this.updatePaginatedWorkOrders();
      
      // Mark work orders as loaded
      this.workOrdersLoaded = true;
      
      // Process any pending actions now that data is loaded
      this.processPendingAction();
    } catch (error) {
      console.error('Error loading work orders:', error);
      this.errorMessage = 'Failed to load work orders. Please try again.';
      // Fallback to mock data if API fails
      this.loadMockData();
    } finally {
      this.isLoading = false;
    }
  }
  
  private normalizePriority(priority: string): string {
    const priorityMap: { [key: string]: string } = {
      'HIGH': 'High',
      'MEDIUM': 'Medium',
      'LOW': 'Low'
    };
    return priorityMap[priority] || priority;
  }

  loadMockData() {
    this.workOrders = [
      { 
        id: 'WO-20241008', 
        title: 'Suspension Repair - Front Struts',
        description: 'Replace front struts and strut mounts. Customer reports clunking noise over bumps and uneven tire wear.',
        status: 'Pending',
        priority: 'High',
        assignee: 'Amanda Harris',
        vehicle: '2021 Nissan Altima',
        estimatedHours: 2.5,
        dueDate: '10/29/2025',
        steps: [
          { number: 1, completed: false },
          { number: 2, completed: false },
          { number: 3, completed: false },
          { number: 4, completed: false },
          { number: 5, completed: false },
          { number: 6, completed: false }
        ]
      },
      { 
        id: 'WO-20241005', 
        title: 'Tesla Software Update and Diagnostics',
        description: 'Perform software update for Tesla Model 3. Run full diagnostic check on battery and electric motor systems. Customer reported range anxiety.',
        status: 'Assigned',
        priority: 'Low',
        assignee: 'William Taylor',
        vehicle: '2022 Tesla Model 3',
        estimatedHours: 2.5,
        dueDate: '10/29/2025',
        steps: [
          { number: 1, completed: true },
          { number: 2, completed: false },
          { number: 3, completed: false },
          { number: 4, completed: false },
          { number: 5, completed: false },
          { number: 6, completed: false }
        ]
      },
      { 
        id: 'WO-20241002', 
        title: 'Brake Pad Replacement - Front',
        description: 'Replace front brake pads and resurface rotors. Customer reported squeaking noise when braking.',
        status: 'Assigned',
        priority: 'Medium',
        assignee: 'Emily Thompson',
        vehicle: '2019 Honda Accord',
        estimatedHours: 2.5,
        dueDate: '10/29/2025',
        steps: [
          { number: 1, completed: true },
          { number: 2, completed: true },
          { number: 3, completed: true },
          { number: 4, completed: false }
        ]
      },
      { 
        id: 'WO-20240998', 
        title: 'Engine Oil Change Service',
        description: 'Standard oil change service with filter replacement. Inspect all fluid levels and tire pressure.',
        status: 'In Progress',
        priority: 'Low',
        assignee: 'Michael Chen',
        vehicle: '2020 Toyota Camry',
        estimatedHours: 1,
        dueDate: '10/28/2025',
        steps: [
          { number: 1, completed: true },
          { number: 2, completed: true },
          { number: 3, completed: false }
        ]
      },
      { 
        id: 'WO-20240995', 
        title: 'Transmission Fluid Exchange',
        description: 'Complete transmission fluid exchange. Customer reports shifting issues and transmission slipping.',
        status: 'In Progress',
        priority: 'High',
        assignee: 'Sarah Rodriguez',
        vehicle: '2018 Ford F-150',
        estimatedHours: 3,
        dueDate: '10/30/2025',
        steps: [
          { number: 1, completed: true },
          { number: 2, completed: true },
          { number: 3, completed: true },
          { number: 4, completed: true },
          { number: 5, completed: false }
        ]
      },
      { 
        id: 'WO-20240990', 
        title: 'Air Conditioning System Repair',
        description: 'Diagnose and repair A/C system. Customer reports weak cooling and strange odor from vents.',
        status: 'Completed',
        priority: 'Medium',
        assignee: 'James Wilson',
        vehicle: '2021 Chevrolet Malibu',
        estimatedHours: 4,
        dueDate: '10/27/2025',
        steps: [
          { number: 1, completed: true },
          { number: 2, completed: true },
          { number: 3, completed: true },
          { number: 4, completed: true }
        ]
      }
    ];

    this.filteredWorkOrders = [...this.workOrders];
    this.updatePaginatedWorkOrders();
  }

  filterByStatus(status: string) {
    this.selectedTab = status;
    this.currentPage = 0;
    this.applyFilters();
  }

  filterByPriority(priority: string) {
    this.selectedPriority = priority;
    this.currentPage = 0;
    this.applyFilters();
  }

  applyFilters() {
    let filtered = [...this.workOrders];

    // Apply status filter
    if (this.selectedTab !== 'All') {
      filtered = filtered.filter(order => order.status === this.selectedTab);
    }

    // Apply priority filter
    if (this.selectedPriority !== 'All') {
      filtered = filtered.filter(order => order.priority === this.selectedPriority);
    }

    this.filteredWorkOrders = filtered;
    this.updatePaginatedWorkOrders();
  }

  getPriorityFilterSeverity(priority: string): 'danger' | 'warning' | 'success' | 'primary' | 'secondary' {
    if (this.selectedPriority === priority) {
      switch (priority.toLowerCase()) {
        case 'high':
          return 'danger';
        case 'medium':
          return 'warning';
        case 'low':
          return 'success';
        default:
          return 'primary';
      }
    }
    return 'secondary';
  }

  onPageChange(event: any) {
    this.currentPage = event.page;
    this.itemsPerPage = event.rows;
    this.updatePaginatedWorkOrders();
  }

  updatePaginatedWorkOrders() {
    const startIndex = this.currentPage * this.itemsPerPage;
    const endIndex = startIndex + this.itemsPerPage;
    this.paginatedWorkOrders = this.filteredWorkOrders.slice(startIndex, endIndex);
  }

  getPriorityBadgeSeverity(priority: string): 'danger' | 'warning' | 'success' | 'info' {
    switch (priority.toLowerCase()) {
      case 'high':
        return 'danger';
      case 'medium':
        return 'warning';
      case 'low':
        return 'success';
      default:
        return 'info';
    }
  }

  async startWork(order: any) {
    try {
      console.log('[WorkOrder] Starting/Resuming work on:', order);
      
      // Check if modal is available
      if (!this.workOrderModal) {
        console.error('[WorkOrder] Work order modal component is not available!');
        alert('Work order modal is not initialized. Please refresh the page.');
        return;
      }
      
      // Determine action based on completed steps
      const action = order.completedSteps > 0 ? 'resume' : 'start';
      
      // Open the work order modal with appropriate action and reload callback
      console.log('[WorkOrder] Opening modal for:', order.id, 'Action:', action);
      this.workOrderModal.open(order.id, undefined, action, () => {
        // Reload work orders when modal closes
        console.log('[WorkOrder] Modal closed, reloading work orders...');
        this.loadWorkOrders();
      });
      
    } catch (error) {
      console.error('[WorkOrder] Failed to start work:', error);
      alert('Failed to start work order. Please try again.');
    }
  }
  
  async restartWork(order: any) {
    try {
      console.log('[WorkOrder] Restarting work on:', order);
      
      // Confirm with user before restarting
      const confirmed = confirm(`Are you sure you want to restart work order ${order.id}? This will reset all progress.`);
      if (!confirmed) {
        return;
      }
      
      // Clear session data for fresh start
      sessionStorage.removeItem('current_session_id');
      sessionStorage.removeItem('current_work_order');
      sessionStorage.removeItem('completed_step');
      
      // Check if modal is available
      if (!this.workOrderModal) {
        console.error('[WorkOrder] Work order modal component is not available!');
        alert('Work order modal is not initialized. Please refresh the page.');
        return;
      }
      
      // Open the work order modal with 'restart' action and reload callback
      console.log('[WorkOrder] Opening modal for restart:', order.id);
      this.workOrderModal.open(order.id, undefined, 'restart', () => {
        // Reload work orders when modal closes
        console.log('[WorkOrder] Modal closed after restart, reloading work orders...');
        this.loadWorkOrders();
      });
      
    } catch (error) {
      console.error('[WorkOrder] Failed to restart work:', error);
      alert('Failed to restart work order. Please try again.');
    }
  }
  
  private normalizeStatus(status: string): string {
    const statusMap: { [key: string]: string } = {
      'PENDING': 'Pending',
      'ASSIGNED': 'Assigned',
      'IN_PROGRESS': 'In Progress',
      'COMPLETED': 'Completed',
      'ON_HOLD': 'On Hold'
    };
    return statusMap[status] || status;
  }
}

