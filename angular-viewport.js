angular.module('viewportFactory',[])

.factory('ViewportFactory', ['$interval','$rootScope', function($interval, $rootScope) {

	/**
		Options available:
			- scope (required): the scope that will be transformed.
			- ObjectService (required): the service that will be queried
			- pageSize: number of items per page
			- arrayAttr: the name of the attribute of the object sent by the server that holds the array of items. Defaults to "results".
			- arraySort: function used for sorting items received from the server. This function receives two objects, "a" and "b", an should
						 return -1 if "a" comes before "b", 1 if "a" comes after "b" and 0 if both are equal. This function is optional.
			- queryArgs: object to be passed as a parameter to ObjectService when new objects are fetched.
			- initialQueryArgs: object to be passed as a parameter to ObjectService when new objects are fetched for the first time. Note
						that in the first fetch, both these args as well as "queryArgs" will be sent to the server.
			- shouldLoad: boolean indicating if the objects should be loaded from the server right after the viewport is initialized.
			              This defaults to true and should generally be left that way, it should only be used when the viewport is showing
			              items that don't exist in the server and therefore querying the server would yield errors.
            - notifiableUpdates: boolean that, if true, indicated that whenever an object is updated, a notification should be shown to the user. The
						   notification itself will not be shown by this factory but if a NotificationCacheManager is being used with this viewport, it will
						   be alerted that a notification must be shown for the object. This defaults to false, which means a notification will only be
						   shown if there are new items and it will not be shown if an existing item was updated.
			- reverse: boolean indicating if the array of objects is shown in reverse order, i.e. new items are at the end of the list
				       and paginated items should be placed at the start. Defaults to false.
			- eventUpdate: string indicating the name of the event that should trigger an update. This event should
						    be used only when using DataSyncHelper.
			- eventDelete: string indicating the name of the event that should trigger the deletion of items. This event should
						    be used only when using DataSyncHelper.
			- eventPolling: string indicating the name of the event that should trigger a reprocessing of the viewport. This event should
						    be used only when using GlobalPolling.

		Pre processing updates:
			If some action is needed before processing an update, the original scope can implement the method $scope.preProcessUpdate. If implemented,
			this method will be called receiving the update event and the objects received with the event. It must return an array with all the objects
			that should be considered in the update. This method is useful for filtering which objects received in the update should be added to the
			viewport.

		First fetch finished:
			Whenever the viewport finishes loading objects for the first time, it will call the method firstFetchFinished with no arguments if it is defined.

		Viewport updates:
			Whenever an update is received, every object in the update is checked to see if it is a new object or an existing object that was updated.
			This verification will generally be done based on the "id" of the item received from the server: if an object with the same id already exists
			in cache, it will be updated, otherwise, a new item is added to the cache. This verification process (based on the id) can be overriden in
			order to provide more sofisticated comparisons if necessary. For this, if the original scope implements a method called "compareItem", then
			this method will be called instead of verifying only their ids. The method will receive as arguments the item received from the server and the
			item that exists in cache and it must return true if both items are the same or false if not.

			If an existing object was updated, the object's "updateCount" attribute will be incremented (starting from 1) and if a new item was received, its "isNew" attribute
			will be set to true. These attributes can be used for displaying new items or updated items in a different way as old items. Note that these objects'
			"updateCount" and "isNew" attributes will never be reset and, therefore, your implementation should deal with that.

	*/

	function scopeToViewport(options) {
		var defaultOptions = {
			arrayAttr: "results",
			reverse: false,
			shouldLoad: true,
			notifiableUpdates: false
		};

		options = angular.extend({}, defaultOptions, options);

		var $scope = options['scope'];
		var ObjectService = options['ObjectService'];

		// Number of items per page - can be undefined if not paginating
		$scope.pageSize = options['pageSize'];

		// Attribute that should be accessed to get the array of items sent by the server
		// If undefined, the results received are expected to be an object with a "results" property
		// that should contain an array.
		$scope.arrayAttr = options['arrayAttr'];

		// Function used for sorting items received from the server.
		$scope.arraySort = options['arraySort'];

		// Object passed as an argument to the query method
		$scope.queryArgs = angular.extend({}, options['queryArgs'])

		// Object passed as an argument to the query method only in the first query
		$scope.initialQueryArgs = angular.extend({}, options['initialQueryArgs']);

		// Boolean indicating if the objects should be loaded from the server
		$scope.shouldLoad = options["shouldLoad"];

		// Boolean indicating if notifications are shown on updates
		$scope.notifiableUpdates = options["notifiableUpdates"];

		// Boolean indicating if array should be reversed
		$scope.reverse = options["reverse"];

		// Name of the event that triggers an update
		$scope.eventUpdate = options["eventUpdate"];

		// Name of the event that triggers a deletion
		$scope.eventDelete = options["eventDelete"];

		// Name of the event that triggers a refresh of the data
		$scope.eventPolling = options["eventPolling"];

		// Data sent by the server. Useful for when the server does not send an array
		$scope.serverData = {};

		// List of all objects >> necessary for caching items
		$scope.allObjects = [];

		// List of all search results >> necessary for caching search results
		$scope.allSearchResults = [];

		// List of objects shown
		$scope.objectsViewport = [];

		// Object that holds all boolean flags. Avoids binding problems.
		$scope.flags = {};

		// Boolean flag to show progress bar when starting and searching
		$scope.flags.isLoading = false;

		// Boolean flag to change the "load more" button state
		$scope.flags.isLoadingMore = false;

		// Boolean flag to change the "create object" button state
		$scope.flags.isCreatingObject = false;

		// Boolean flag to indicate that search results are being shown
		$scope.flags.isSearchDone = false;

		// Boolean flag to hide other objects when editing. Used by children object items.
		$scope.flags.editMode = false;

		// Boolean flag to indicate a search is being performed.
		// Used for hiding the "load more" button.
		$scope.flags.isSearching = false;

		// Pagination data
		$scope.pagination = {
				// Current page of results
			page: 0,
				// Boolean flag to show "load more" button
			more: false,
				// Boolean flag used only when paginating to store the current state of the server
			moreOnServer: true,
				// Boolean flag used only when paginating indicating if there are pages before the current one
			previous: false,
				// Total number of pages
			numberPages: 0,
				// Total number of results
			numberResults: 0,
				// Index of first item shown
			firstItem: 0,
				// Index of last item shown
			lastItem: 0
		};

		// Pagination cache. Used for when switching back from search results.
		var paginationCache = angular.copy($scope.pagination);

		// Just an object representing the empty state to be copied when starting a search
		var emptyPagination = angular.copy($scope.pagination);

		// Variable bound to the search input field
		$scope.searchText = "";

		// Current search term
		$scope.currentSearch = "";


		/**
			This function is called everytime the "load more" button is clicked (but only
			after results were fetched from the server), in order to update the viewport
			with the newly fetched items. For the case when using pagination, it is called
			when switching pages.

		*/
		$scope.resetViewport = function () {
			if (typeof $scope.arraySort !== "undefined") {
				$scope.allObjects.sort($scope.arraySort);
			}
			if ($scope.pageSize) {
				var cachedArray = $scope.flags.isSearching ? $scope.allSearchResults.slice(0) : $scope.allObjects.slice(0);
				var startIdx = $scope.pageSize*($scope.pagination.page - 1);
				var endIdx = Math.min($scope.pageSize*$scope.pagination.page, cachedArray.length);
				if ($scope.reverse) {
					cachedArray.reverse();
				}
				var arraySlice = cachedArray.slice(startIdx, endIdx);

				$scope.objectsViewport.length = 0;

				if ($scope.reverse) {
					arraySlice.reverse();
				}
				Array.prototype.push.apply($scope.objectsViewport, arraySlice);

				var lastCache = cachedArray[cachedArray.length - 1];
				var lastDisplay = $scope.objectsViewport[$scope.objectsViewport.length - 1];
				$scope.pagination.more = ($scope.pagination.moreOnServer) || (lastCache !== lastDisplay);
				calculateNumberPages();

			} else {
				$scope.objectsViewport.length = 0;
				if (!$scope.flags.isSearching) {
					Array.prototype.push.apply($scope.objectsViewport, $scope.allObjects);
				} else {
					Array.prototype.push.apply($scope.objectsViewport, $scope.allSearchResults);
				}
			}
		}

		/**
			Callback for the create object button.
		*/
		$scope.onCreate = function () {
			$scope.flags.isCreatingObject = true;
			ObjectService.create(function(object) {
				$scope.flags.isCreatingObject = false;
				object.isEditing = true;
				$scope.flags.editMode = true;
				$scope.allObjects.unshift(object);
				$scope.resetViewport();
			});

		};

		/**
			Function that removes the object after its deletion was confirmed by the user.
			This function is called by the children ObjectItems.
		*/
		$scope.removeObject = function(object) {
			var idx = $scope.allObjects.indexOfObject(object);
			$scope.allObjects.splice(idx, 1);
			$scope.resetViewport();
		};

		/**
			Alias to be used when paginating.
		*/
		$scope.onNextPage = function() {
			$scope.onLoadMore();
		};

		/**
			Recalculates the viewport to move to the previous page.
		*/
		$scope.onPreviousPage = function() {
			if (!$scope.pagination.previous) {
				throw "Pagination error: there are no previous pages. Did you forget to disable the pagination button?";
			}
			$scope.pagination.page -= 1;
			$scope.pagination.previous = $scope.pagination.page > 1;
			$scope.resetViewport();
		};

		/**
			Stores metadata about the pagination, such as total number of pages
			and the indices of items shown.
		*/
		function calculateNumberPages() {
			if (!$scope.pageSize) {
				return;
			}
			var cachedArray = $scope.flags.isSearching ? $scope.allSearchResults : $scope.allObjects;
			if ($scope.objectsViewport.length > 0) {
				$scope.pagination.firstItem = cachedArray.indexOfObject($scope.objectsViewport[0]) + 1;
				$scope.pagination.lastItem = cachedArray.indexOfObject($scope.objectsViewport[$scope.objectsViewport.length - 1]) + 1;
			}
			$scope.pagination.numberPages = Math.ceil($scope.pagination.numberResults/$scope.pageSize);
		}

		/**
			Callback for the "load more" button.
			The "hideLoading" parameter indicates if the operation should
			change the "isLoading" flag. This flag is used internally and
			should not be used directly.
		*/
		$scope.onLoadMore = function (hideLoading) {
			var isInitial = $scope.pagination.page === 0;
			if (isInitial) {
				if (!hideLoading) {
					$scope.flags.isLoading = true;
				}
			} else {
				$scope.flags.isLoadingMore = true;
			}


			if ($scope.pageSize && !isInitial) { // Cached pagination
				var lowerBound = $scope.pageSize * ($scope.pagination.page);
				var upperBound = $scope.pageSize * ($scope.pagination.page + 1);
				var cachedArray = $scope.flags.isSearching ? $scope.allSearchResults : $scope.allObjects;

				if (upperBound > cachedArray.length && $scope.pagination.moreOnServer) {

					loadFromServer(false); // No more items in cache

				} else if (lowerBound < cachedArray.length){

					$scope.pagination.page += 1;
					$scope.pagination.previous = $scope.pagination.page > 1;
					$scope.resetViewport();
					$scope.flags.isLoadingMore = false;

				} else {
					// If we got here, there was a problem, because there
					// are no more items in the server and no more items in cache
					throw "Pagination error: there are no more items on the server, so this function should not be called. Did you forget to disable the pagination button?";
				}

			} else { // Load more pagination
				if ($scope.shouldLoad) {
					loadFromServer(isInitial);
				} else {
					if (isInitial) {
						$scope.flags.isLoading = false;
					} else {
						$scope.flags.isLoadingMore = false;
					}
				}
			}
		};

		/**
			Discards the cached items and reloads everything.
			The "hideLoading" parameter indicates if the operation should
			change the "isLoading" flag. This is used for refreshing the page
			without the user noticing.
		*/
		$scope.onRefresh = function(hideLoading) {
			if ($scope.flags.isSearching) {
				$scope.onClearSearch();
			}

			angular.extend($scope.pagination, emptyPagination)
			$scope.onLoadMore(hideLoading);
		};

		/**
			Loads data from the server. This function is called
			everytime a user presses the load more button when not
			using pagination. For the case where the results are being
			cached, this is only called when there are no more items in cache.
		*/
		function loadFromServer(isInitial, callback) {
			var queryParams = angular.copy($scope.queryArgs);
			angular.extend(queryParams, {page:$scope.pagination.page + 1});

			if (isInitial) {
				angular.extend(queryParams, $scope.initialQueryArgs);
			}

			if ($scope.flags.isSearching) {
				queryParams.search = $scope.currentSearch;
			}

			ObjectService.query(queryParams,function(data) {
				processServerResults(data, isInitial);
			});
		};

		/**
			Processes the results received from the server:
			- Increments pagination
			- Stores flags indicating if there are more items on
			  the server
			- Resets the viewport
			- Changes loading flags
		*/
		function processServerResults(data, isInitial, backgroundUpdate) {
			var arrayData;
			var isArray = angular.isArray(data);
			if (!isArray) {
				angular.extend($scope.serverData, data);
				arrayData = data[$scope.arrayAttr];
			} else {
				arrayData = data;
			}

			if (backgroundUpdate) {
				paginationCache.page += 1;
				paginationCache.previous = paginationCache.page > 1;
				paginationCache.more = data.next !== null;
				paginationCache.moreOnServer = paginationCache.more;
				paginationCache.numberResults = data.count;
			} else {
				$scope.pagination.page += 1;
				$scope.pagination.previous = $scope.pagination.page > 1;
				$scope.pagination.more = data.next !== null;
				$scope.pagination.moreOnServer = $scope.pagination.more;
				$scope.pagination.numberResults = data.count;
			}

			if (!$scope.flags.isSearching || backgroundUpdate){
				if (isInitial) {
					$scope.allObjects.length = 0;
				}
				var addToArray = $scope.reverse ? Array.prototype.unshift : Array.prototype.push;

				arrayData.forEach(function(receivedItem){
					var idx = checkItemInCache(receivedItem);

					if (idx == -1) { // New item received
						addToArray.apply($scope.allObjects, [receivedItem]);
					} else { // Existing item received
						angular.extend($scope.allObjects[idx], receivedItem);
					}
				});

				if (!backgroundUpdate) {
					$scope.resetViewport();
				}
			} else {
				if (isInitial) {
					$scope.allSearchResults.length = 0;
				}
				Array.prototype.push.apply($scope.allSearchResults,arrayData);
				$scope.resetViewport();
			}
			if (isInitial) {
				$scope.flags.isLoading = false;
			} else {
				$scope.flags.isLoadingMore = false;
			}

			if (isInitial && typeof $scope.firstFetchFinished !== "undefined") {
				$scope.firstFetchFinished();
			}
		}

		/**
			Function that checks if an item received from the server is new
			or already exists in cache. This function will compare items
			based on their ids or on the scope function "compareItems" if
			it was defined in the original scope.

			The function will return the index of the item in the "allObjects"
			array or -1 it is not found.
		*/
		function checkItemInCache(receivedItem) {
			if (typeof $scope.compareItems !== "undefined") {
				for (var idx=0; idx<$scope.allObjects.length; idx++) {
					var existingItem = $scope.allObjects[idx];

					if ($scope.compareItems(receivedItem, existingItem)) {
						return idx;
					}
				}
				return -1;
			} else {
				return $scope.allObjects.indexOfObject(receivedItem);
			}
		}

		/**
			Function called whenever new objects are available for this view.
			It is triggered by an event broadcasted by DataSyncHelper.
		*/
		$scope.processUpdate = function (event, newObjects) {
			var shouldResetViewport = typeof $scope.arraySort !== "undefined";
			var notifiableObjects = []

			if (typeof $scope.preProcessUpdate !== "undefined") {
				newObjects = $scope.preProcessUpdate(event, newObjects);
				if (newObjects.length == 0) {
					return;
				}
			}

			newObjects.forEach(function(obj, idx){
				var oldIdx = $scope.allObjects.indexOfObject(obj);
				if (oldIdx !== -1) {
					var oldItem =  $scope.allObjects[oldIdx];

					// Existing object was updated
					if (typeof oldItem.updateCount === "undefined") {
						oldItem.updateCount = 1;
					} else {
						oldItem.updateCount = oldItem.updateCount + 1;
					}

					angular.extend(oldItem, obj);
					if ($scope.notifiableUpdates) {
						notifiableObjects.push(oldItem);
					}
				} else {
					// New object arrived
					obj.isNew = true;
					notifiableObjects.push(obj);
					shouldResetViewport = true;
					if (!$scope.reverse) {
						$scope.allObjects.unshift(obj);
					} else {
						$scope.allObjects.push(obj);
					}
				}

			});

			if (!$scope.flags.isSearching && shouldResetViewport) {
				$scope.resetViewport();
			}

			return notifiableObjects;
		};

		/**
			Function called whenever the GlobalPolling mechanism
			identified that the data should be updated.
		*/
		$scope.processPolling = function(event, newData) {
			var backgroundUpdate = $scope.flags.isSearching;
			if (backgroundUpdate) {
				angular.extend(paginationCache, emptyPagination);
			} else {
				angular.extend($scope.pagination, emptyPagination);
			}
			$scope.onRefresh(backgroundUpdate);
			// processServerResults(newData, true, backgroundUpdate);
		};

		/**
			Function called whenever items are deleted and should be removed.
			It is triggered by an event broadcasted by DataSyncHelper.
		*/
		$scope.processDelete = function(event, deletedObjects) {
			var shouldResetViewport = false;
			deletedObjects.forEach(function(object,idx){
				var id = getObjectId(object);
				var oldIdx = $scope.allObjects.indexOfObject({"id":id});
				if (oldIdx !== -1) {
					// We have an object that must be deleted
					$scope.allObjects.splice(oldIdx, 1);
					shouldResetViewport = true;
				}
			});

			if (!$scope.flags.isSearching && shouldResetViewport) {
				$scope.resetViewport();
			}
		};

		/**
			Helper function that finds the id of an object.
			It loops through the objects properties
		*/
		function getObjectId(object) {
			var keys = Object.keys(object);
			var id = 0;
			keys.forEach(function(key,idx){
				if (key.indexOf("id") !== -1) {
					id=object[key];
				}
			});
			if (id === 0) {
				throw "Object id was not found for object: " + JSON.stringify(object);
			}
			return id;
		}

		/**
			Callback for the search button
		*/
		$scope.onSearch = function () {
			if ($scope.searchText === '') {
				return $scope.onClearSearch();
			}
			if (!$scope.flags.isSearching) {
				paginationCache = angular.copy($scope.pagination);
			}

			$scope.flags.isSearching = true;
			$scope.currentSearch = $scope.searchText;
			$scope.objectsViewport = [];

			angular.extend($scope.pagination, emptyPagination)
			$scope.onLoadMore();

		};


		/**
			Callback for clear (x) button
		*/
		$scope.onClearSearch = function () {
			$scope.flags.isSearching = false;
			$scope.flags.isLoading = false;
			$scope.currentSearch = "";
			$scope.searchText = "";
			$scope.pagination = angular.copy(paginationCache);
			$scope.allSearchResults.length = 0;
			$scope.resetViewport();
		};

		/**
			Makes the "isSearchDone" property available
			for identifying when a user searched for something and
			the results are in. Useful for knowing when to display
			"X results were found" type of information.
		*/
		$scope.$watch(function(){
			return $scope.flags.isSearching && !$scope.flags.isLoading;
		}, function(newVal) {
			$scope.flags.isSearchDone = newVal;
		});


		// EVENTS
		// Start listening to update event
		if (typeof $scope.eventUpdate !== 'undefined') {
			$scope.$on($scope.eventUpdate, $scope.processUpdate);
		}

		// Start listening to delete event
		if (typeof $scope.eventDelete !== 'undefined') {
			$scope.$on($scope.eventDelete, $scope.processDelete);
		}

		// Start listening to polling event
		if (typeof $scope.eventPolling !== 'undefined') {
			$scope.$on($scope.eventPolling, $scope.processPolling);
		}

		$scope.onLoadMore();
	}

	return {
		scopeToViewport: scopeToViewport
	};

}]);