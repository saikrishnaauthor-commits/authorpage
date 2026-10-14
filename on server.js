warning: in the working copy of 'catalog.json', LF will be replaced by CRLF the next time Git touches it
warning: in the working copy of 'server.js', LF will be replaced by CRLF the next time Git touches it
[1mdiff --git a/catalog.json b/catalog.json[m
[1mindex 3d53d85..3892998 100644[m
[1m--- a/catalog.json[m
[1m+++ b/catalog.json[m
[36m@@ -4,7 +4,7 @@[m
     "desc": "Time is a wheel turning endlessly through eras of light and shadow.",[m
     "image": "images/kaalyug.png",[m
     "pbId": "book_1_pb",[m
[31m-    "pbPrice": 2,[m
[32m+[m[32m    "pbPrice": 249,[m
     "ebId": "book_1_eb",[m
     "ebPrice": 25[m
   },[m
[36m@@ -22,7 +22,7 @@[m
     "desc": "Primal energy, myth, and the ultimate resilience of the cosmos.",[m
     "image": "images/kali.jpeg",[m
     "pbId": "book_3_pb",[m
[31m-    "pbPrice": 399,[m
[32m+[m[32m    "pbPrice": 299,[m
     "ebId": "book_3_eb",[m
     "ebPrice": 25[m
   }[m
[1mdiff --git a/server.js b/server.js[m
[1mindex dcbe076..c72897f 100644[m
[1m--- a/server.js[m
[1m+++ b/server.js[m
[36m@@ -117,11 +117,11 @@[m [mconst transporter = nodemailer.createTransport({[m
 [m
 // Author Books Inventory (Synced with catalog.json)[m
 const BOOKS = [[m
[31m-  { id: 'book_1_pb', name: 'KaalYug: Shadows of Dark Web (Paperback)', price: 2, type: 'Paperback' },[m
[32m+[m[32m  { id: 'book_1_pb', name: 'KaalYug: Shadows of Dark Web (Paperback)', price: 249, type: 'Paperback' },[m
   { id: 'book_1_eb', name: 'KaalYug: Shadows of Dark Web (E-Book)', price: 25, type: 'E-Book' },[m
   { id: 'book_2_pb', name: 'Pages of Us (Paperback)', price: 299, type: 'Paperback' },[m
   { id: 'book_2_eb', name: 'Pages of Us (E-Book)', price: 25, type: 'E-Book' },[m
[31m-  { id: 'book_3_pb', name: 'The Indestructible Kali (Paperback)', price: 399, type: 'Paperback' },[m
[32m+[m[32m  { id: 'book_3_pb', name: 'The Indestructible Kali (Paperback)', price: 299, type: 'Paperback' },[m
   { id: 'book_3_eb', name: 'The Indestructible Kali (E-Book)', price: 25, type: 'E-Book' }[m
 ];[m
 [m
